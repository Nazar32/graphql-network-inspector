import { useCallback, useEffect, useRef } from 'react'
import { v4 as uuid } from 'uuid'
import {
  parseGraphqlBody,
  getFirstGraphqlOperation,
} from '../helpers/graphqlHelpers'
import {
  onRequestFinished,
  onBeforeRequest,
  onBeforeSendHeaders,
  getHAR,
} from '../services/networkMonitor'
import {
  IIncompleteNetworkRequest,
  ICompleteNetworkRequest,
  IResponseChunk,
  getRequestBody,
  isRequestComplete,
  urlHasFileExtension,
  isMultipartMixedResponse,
  getMultipartMixedBoundary,
  parseMultipartMixedResponse,
  isSSEResponse,
  parseSSEResponse,
  getRequestMatchConfidence,
  getNetworkRequestStartTime,
  MATCH_CONFIDENCE_RANK,
} from '../helpers/networkHelpers'
import useLatestState from './useLatestState'
import { logDiagnostic } from '../services/diagnostics'

export interface IClearWebRequestsOptions {
  clearPending?: boolean
  clearAll?: boolean
}

/**
 * Validate that a network request is a valid graphql request
 * by checking the request body for a valid graphql operation
 *
 */
const validateNetworkRequest = async (
  details: chrome.devtools.network.Request
) => {
  try {
    const body = await getRequestBody(details)
    if (!body) {
      return false
    }

    const graphqlRequestBody = parseGraphqlBody(body)
    if (!graphqlRequestBody) {
      return false
    }

    const primaryOperation = getFirstGraphqlOperation(graphqlRequestBody)
    if (!primaryOperation) {
      return false
    }
  } catch (error) {
    console.error('Error validating network request', error)
    return false
  }

  return true
}

/**
 * Produce a section of the full ICompleteNetworkRequest object
 * from the details and responseBody of a chrome.devtools.network.Request
 *
 * @param details
 * @param responseBody the response body of the request.getContent callback
 */
const processNetworkRequest = (
  details: chrome.devtools.network.Request,
  responseBody: string
) => {
  const isMultipart = isMultipartMixedResponse(details.response.headers)
  const boundary = isMultipart
    ? getMultipartMixedBoundary(details.response.headers)
    : undefined

  let chunks: IResponseChunk[] | undefined
  let finalBody = responseBody
  let isStreaming = false

  // Parse multipart/mixed response to extract incremental chunks
  if (isMultipart && boundary) {
    try {
      chunks = parseMultipartMixedResponse(responseBody, boundary)
      isStreaming = true

      // Use the first chunk as the body for backwards compatibility
      // The first chunk is usually the initial response
      if (chunks.length > 0) {
        finalBody = chunks[0].body
      }
    } catch (e) {
      console.error('Error parsing multipart response:', e)
      // Fall back to treating as regular response
    }
  } else if (isSSEResponse(details.response.headers)) {
    try {
      chunks = parseSSEResponse(responseBody)
      isStreaming = true

      if (chunks.length > 0) {
        finalBody = chunks[0].body
      }
    } catch (e) {
      console.error('Error parsing SSE response:', e)
      // Fall back to treating as regular response
    }
  }

  return {
    status: details.response.status,
    url: details.request.url,
    time: details.time === -1 || !details.time ? 0 : details.time,
    method: details.request.method,
    response: {
      headers: details.response.headers,
      headersSize: details.response.headersSize,
      body: finalBody,
      bodySize:
        details.response.bodySize === -1
          ? details.response._transferSize || 0
          : details.response.bodySize,
      chunks,
      isStreaming,
    },
  }
}

/**
 * Match a network request to a webRequest.
 *
 * The webRequest api and the devtools network api share no request id, so
 * the pair must be found by comparing fields. Each pending request is given
 * a confidence level and the strongest one wins. When several requests are
 * equally strong, we pick the one that started closest to this response.
 *
 * @param webRequests every request we have seen so far
 * @param details the finished devtools network request
 * @returns the matching pending request, or undefined
 */
const findMatchingWebRequest = async (
  webRequests: IIncompleteNetworkRequest[],
  details: chrome.devtools.network.Request
): Promise<IIncompleteNetworkRequest | undefined> => {
  const scored = await Promise.all(
    webRequests
      // Don't target requests that already have a response
      .filter((webRequest) => !webRequest.response)
      .map(async (webRequest) => ({
        webRequest,
        rank: MATCH_CONFIDENCE_RANK[
          await getRequestMatchConfidence(
            details,
            webRequest.native?.webRequest || null,
            webRequest.request?.headers || []
          )
        ],
      }))
  )

  const matches = scored.filter((match) => match.rank > 0)
  if (!matches.length) {
    return undefined
  }

  const bestRank = Math.max(...matches.map((match) => match.rank))

  if (bestRank < MATCH_CONFIDENCE_RANK.body) {
    // The request body was not available on both sides, so the pair was
    // found from weaker signals. This is expected on Chrome 152 and later.
    console.debug(
      '[GraphQL Network Inspector] paired a response without a body match',
      { url: details.request.url, rank: bestRank }
    )
  }
  const bestMatches = matches.filter((match) => match.rank === bestRank)
  if (bestMatches.length === 1) {
    return bestMatches[0].webRequest
  }

  const startTime = getNetworkRequestStartTime(details)
  if (startTime === undefined) {
    return bestMatches[0].webRequest
  }

  const closest = bestMatches.reduce((best, match) => {
    const bestStart = best.webRequest.native?.webRequest?.timeStamp || 0
    const matchStart = match.webRequest.native?.webRequest?.timeStamp || 0
    return Math.abs(matchStart - startTime) < Math.abs(bestStart - startTime)
      ? match
      : best
  }, bestMatches[0])

  return closest.webRequest
}

export const useNetworkMonitor = (): [
  ICompleteNetworkRequest[],
  (opts?: IClearWebRequestsOptions) => void
] => {
  const [requests, setRequests, getLatestRequests] = useLatestState<
    IIncompleteNetworkRequest[]
  >([])

  // Track if component is mounted to prevent state updates after unmount
  const isMountedRef = useRef(true)
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const handleBeforeRequest = useCallback(
    (details: chrome.webRequest.WebRequestBodyDetails) => {
      if (details.method === 'GET' && urlHasFileExtension(details.url)) {
        return
      }

      logDiagnostic('onBeforeRequest', {
        url: details.url,
        method: details.method,
        requestId: details.requestId,
        hasRawBody: Boolean(details.requestBody?.raw?.length),
      })

      setRequests((request) => {
        const newIncompleteRequest: IIncompleteNetworkRequest = {
          id: details.requestId,
          status: -1,
          url: details.url,
          time: 0,
          method: details.method,
          native: {
            webRequest: details,
          },
        }

        return request.concat(newIncompleteRequest)
      })
    },
    [setRequests]
  )

  const handleBeforeSendHeaders = useCallback(
    async (details: chrome.webRequest.WebRequestHeadersDetails) => {
      if (details.method === 'GET' && urlHasFileExtension(details.url)) {
        return
      }

      const requests = getLatestRequests()

      const matchedRequest = requests.find(
        (request) => request.id === details.requestId
      )
      if (!matchedRequest) {
        return
      }

      // Don't overwrite the request if it's already complete
      if (matchedRequest.response) {
        return matchedRequest
      }

      // Now we have both the headers and the body from the webRequest api
      // we can determine if this is a graphql request.
      //
      // If it is not, we return an empty array so flatMap will remove it.
      const body = await getRequestBody(
        matchedRequest.native.webRequest,
        details.requestHeaders || []
      )

      // Check if still mounted after async operation
      if (!isMountedRef.current) return

      if (!body) {
        return
      }

      const graphqlRequestBody = parseGraphqlBody(body)
      if (!graphqlRequestBody) {
        return
      }

      const primaryOperation = getFirstGraphqlOperation(graphqlRequestBody)
      if (!primaryOperation) {
        return
      }

      const request = {
        primaryOperation,
        body: graphqlRequestBody.map((requestBody) => ({
          ...requestBody,
          id: uuid(),
        })),
        bodySize: body ? body.length : 0,
        headers: details.requestHeaders,
        headersSize: (details.requestHeaders || []).reduce(
          (acc, header) =>
            acc + header.name.length + (header.value?.length || 0),
          0
        ),
      }

      setRequests((prevRequests) => {
        return prevRequests.map((prevRequest) => {
          if (prevRequest.id === matchedRequest.id) {
            return {
              ...prevRequest,
              request,
            }
          } else {
            return prevRequest
          }
        })
      })
    },
    [setRequests, getLatestRequests]
  )

  const handleRequestFinished = useCallback(
    async (details: chrome.devtools.network.Request) => {
      try {
        logDiagnostic('onRequestFinished', {
          url: details.request.url,
          method: details.request.method,
          status: details.response?.status,
          hasPostData: Boolean(details.request?.postData?.text),
          bodySize: details.request?.bodySize,
          startedDateTime: details.startedDateTime,
        })

        if (
          details.request.method === 'GET' &&
          urlHasFileExtension(details.request.url)
        ) {
          return
        }

        // Chrome 152 and later can leave `request.postData` out of the
        // devtools entry, so we cannot always read the body to confirm that
        // this is a GraphQL request. Instead, continue only when a pending
        // request to the same endpoint is waiting for a response. Those
        // pending requests were already confirmed as GraphQL by the
        // webRequest handlers.
        const hasPendingCandidate = getLatestRequests().some(
          (request) =>
            !request.response &&
            request.url === details.request.url &&
            request.method === details.request.method
        )

        logDiagnostic('pendingCandidate', {
          url: details.request.url,
          hasPendingCandidate,
          pendingCount: getLatestRequests().filter((r) => !r.response).length,
        })

        if (!hasPendingCandidate) {
          return
        }

        details.getContent(async (content, encoding) => {
          try {
            // Check if still mounted before processing
            if (!isMountedRef.current) return

            const responseBody = encoding === 'base64' ? atob(content) : content
            const requests = getLatestRequests()
            const matchedRequest = await findMatchingWebRequest(requests, details)

            logDiagnostic('getContent', {
              url: details.request.url,
              encoding,
              contentLength: content ? content.length : 0,
              matched: Boolean(matchedRequest),
            })

            // Check again after async operation
            if (!isMountedRef.current || !matchedRequest) {
              return
            }

            setRequests((prevRequests) => {
              return prevRequests.map((prevRequest) => {
                if (prevRequest.id === matchedRequest.id) {
                  return {
                    ...prevRequest,
                    ...processNetworkRequest(details, responseBody),
                    native: {
                      ...prevRequest.native,
                      networkRequest: details,
                    },
                  }
                } else {
                  return prevRequest
                }
              })
            })
          } catch (error) {
            console.error('Error processing request content:', error)
          }
        })
      } catch (error) {
        console.error('Error handling finished request:', error)
      }
    },
    [setRequests, getLatestRequests]
  )

  const handleHAREntries = useCallback(
    async (entries: chrome.devtools.network.Request[]) => {
      try {
        const validationResults = await Promise.all(
          entries.map(async (details) => {
            if (!('getContent' in details)) {
              return false
            }
            return validateNetworkRequest(details)
          })
        )
        const validEntries = entries.filter(
          (_details, index) => validationResults[index]
        )

        const entriesWithContent = await Promise.all(
          validEntries.map((details) => {
            return new Promise<ICompleteNetworkRequest | null>((resolve) => {
              try {
                details.getContent(async (responseBody) => {
                  try {
                    const body = await getRequestBody(details)
                    if (!body) {
                      resolve(null)
                      return
                    }

                    const graphqlRequestBody = parseGraphqlBody(body)
                    if (!graphqlRequestBody) {
                      resolve(null)
                      return
                    }

                    const primaryOperation =
                      getFirstGraphqlOperation(graphqlRequestBody)
                    if (!primaryOperation) {
                      resolve(null)
                      return
                    }

                    resolve({
                      id: uuid(),
                      ...processNetworkRequest(details, responseBody),
                      request: {
                        primaryOperation,
                        body: graphqlRequestBody.map((requestBody) => ({
                          ...requestBody,
                          id: uuid(),
                        })),
                        bodySize: body ? body.length : 0,
                        headers: details.request.headers,
                        headersSize: details.request.headersSize,
                      },
                      native: {
                        networkRequest: details,
                        webRequest: {} as chrome.webRequest.WebRequestBodyDetails,
                      },
                    })
                  } catch (error) {
                    console.error('Error processing HAR entry content:', error)
                    resolve(null)
                  }
                })
              } catch (error) {
                console.error('Error getting HAR entry content:', error)
                resolve(null)
              }
            })
          })
        )

        // Filter out null entries from failed processing
        const validResults = entriesWithContent.filter(
          (entry): entry is ICompleteNetworkRequest => entry !== null
        )

        // Check if still mounted before setting state
        if (isMountedRef.current) {
          setRequests(validResults)
        }
      } catch (error) {
        console.error('Error handling HAR entries:', error)
      }
    },
    [setRequests]
  )

  const clearRequests = useCallback(
    (opts?: IClearWebRequestsOptions) => {
      const { clearPending = true, clearAll = true } = opts || {}

      if (clearAll) {
        setRequests([])
        return
      }

      if (clearPending) {
        setRequests((webRequests) => {
          return webRequests.filter(
            (webRequest) => typeof webRequest.response !== 'undefined'
          )
        })
      }
    },
    [setRequests]
  )

  // Collect historic network data in case any events fired before we started listening
  useEffect(() => {
    const fetchHistoricWebRequests = async () => {
      try {
        const HARLog = await getHAR()
        handleHAREntries(HARLog.entries as chrome.devtools.network.Request[])
      } catch (error) {
        console.error('Error fetching historic web requests:', error)
      }
    }

    clearRequests()
    fetchHistoricWebRequests()
  }, [handleHAREntries, clearRequests])

  // Setup listeners for network data
  useEffect(() => {
    return onBeforeRequest(handleBeforeRequest)
  }, [handleBeforeRequest])

  useEffect(() => {
    return onBeforeSendHeaders(handleBeforeSendHeaders)
  }, [handleBeforeSendHeaders])

  useEffect(() => {
    logDiagnostic('registerOnRequestFinished', {
      hasApi: Boolean(
        typeof chrome !== 'undefined' &&
          chrome.devtools?.network?.onRequestFinished
      ),
    })
    return onRequestFinished(handleRequestFinished)
  }, [handleRequestFinished])

  // Only return webRequests where the request portion is complete.
  // Since we build up the data from multiple events. We only want
  // to display results that have enough data to be useful.
  const completeRequests = requests.filter(isRequestComplete)

  return [completeRequests, clearRequests]
}
