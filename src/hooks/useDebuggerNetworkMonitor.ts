import { useCallback, useEffect, useRef } from 'react'
import { v4 as uuid } from 'uuid'
import {
  parseGraphqlBody,
  getFirstGraphqlOperation,
} from '../helpers/graphqlHelpers'
import {
  ICompleteNetworkRequest,
  IHeader,
  IResponseChunk,
  isMultipartMixedResponse,
  getMultipartMixedBoundary,
  parseMultipartMixedResponse,
  isSSEResponse,
  parseSSEResponse,
  isPreflightRequest,
} from '../helpers/networkHelpers'
import { chromeProvider } from '../services/chromeProvider'
import {
  attachDebugger,
  detachDebugger,
  sendDebuggerCommand,
  addDebuggerListener,
  addDetachListener,
  ensureDebuggerAttached,
  isDebuggerAttached,
} from '../services/debuggerSession'
import useLatestState from './useLatestState'

export interface IClearWebRequestsOptions {
  clearPending?: boolean
  clearAll?: boolean
}

interface ICdpRequest {
  url: string
  method: string
  headers?: Record<string, string>
  postData?: string
  hasPostData?: boolean
}

interface ICdpResponse {
  status: number
  statusText?: string
  headers?: Record<string, string>
  encodedDataLength?: number
}

// How much of a request body to ask Chrome to send inline
const MAX_POST_DATA_SIZE = 5 * 1024 * 1024

// How often to confirm that the debugger is still attached
const SESSION_CHECK_INTERVAL = 2000

/**
 * Turn the protocol's header map into the list shape the panel uses.
 *
 * @param headers the header map, keyed by header name
 * @returns the headers as a list
 */
const toHeaderList = (headers?: Record<string, string>): IHeader[] => {
  return Object.entries(headers || {}).map(([name, value]) => ({
    name,
    value,
  }))
}

/**
 * Add up the size of a set of headers.
 *
 * @param headers the headers to measure
 * @returns the total number of characters
 */
const getHeadersSize = (headers: IHeader[]): number => {
  return headers.reduce(
    (total, header) => total + header.name.length + (header.value?.length || 0),
    0
  )
}

/**
 * Split a response body into chunks when the response arrives in parts,
 * which happens with the @defer and @stream directives and with
 * subscriptions sent over one connection.
 *
 * @param headers the response headers
 * @param body the raw response body
 * @returns the body to show, and the chunks it was built from
 */
const splitResponseBody = (
  headers: IHeader[],
  body: string
): { body: string; chunks?: IResponseChunk[]; isStreaming: boolean } => {
  const boundary = isMultipartMixedResponse(headers)
    ? getMultipartMixedBoundary(headers)
    : undefined

  try {
    if (boundary) {
      const chunks = parseMultipartMixedResponse(body, boundary)
      return {
        body: chunks.length ? chunks[0].body : body,
        chunks,
        isStreaming: true,
      }
    }

    if (isSSEResponse(headers)) {
      const chunks = parseSSEResponse(body)
      return {
        body: chunks.length ? chunks[0].body : body,
        chunks,
        isStreaming: true,
      }
    }
  } catch (e) {
    console.error('Error splitting response body', e)
  }

  return { body, isStreaming: false }
}

/**
 * Collect GraphQL requests over the Chrome DevTools Protocol.
 *
 * The devtools network api cannot be used for this on Chrome 152 and
 * later. It leaves the request body out of every entry, it reports no
 * finished event for a cross origin POST, and `getContent` returns null.
 * The protocol reports the same traffic with a stable request id, so the
 * request and its response never have to be paired by guesswork.
 */
export const useDebuggerNetworkMonitor = (options: {
  isEnabled: boolean
}): [ICompleteNetworkRequest[], (opts?: IClearWebRequestsOptions) => void] => {
  const { isEnabled } = options

  const [requests, setRequests, getLatestRequests] = useLatestState<
    ICompleteNetworkRequest[]
  >([])

  // When each request started, keyed by the protocol's request id, so the
  // duration can be worked out once it finishes
  const startTimesRef = useRef(new Map<string, number>())

  const updateRequest = useCallback(
    (id: string, update: Partial<ICompleteNetworkRequest>) => {
      setRequests((previous) => {
        const index = previous.findIndex((request) => request.id === id)
        if (index === -1) {
          return previous
        }

        const next = previous.slice()
        next[index] = { ...next[index], ...update }
        return next
      })
    },
    [setRequests]
  )

  const handleRequestWillBeSent = useCallback(
    async (tabId: number, params: any) => {
      const { requestId, request, timestamp } = params as {
        requestId: string
        request: ICdpRequest
        timestamp: number
      }

      // A CORS preflight carries no GraphQL payload
      if (!request || isPreflightRequest(request.method)) {
        return
      }

      let postData = request.postData
      if (!postData && request.hasPostData) {
        const result = await sendDebuggerCommand<{ postData: string }>(
          tabId,
          'Network.getRequestPostData',
          { requestId }
        )
        postData = result?.postData
      }

      if (!postData) {
        return
      }

      // Hold the body in a const so its type survives into the closure below
      const body = postData

      const graphqlRequestBody = parseGraphqlBody(body)
      if (!graphqlRequestBody) {
        return
      }

      const primaryOperation = getFirstGraphqlOperation(graphqlRequestBody)
      if (!primaryOperation) {
        return
      }

      startTimesRef.current.set(requestId, timestamp)

      const headers = toHeaderList(request.headers)

      setRequests((previous) => {
        if (previous.some((existing) => existing.id === requestId)) {
          return previous
        }

        return previous.concat({
          id: requestId,
          url: request.url,
          method: request.method,
          status: -1,
          time: 0,
          request: {
            primaryOperation,
            headers,
            headersSize: getHeadersSize(headers),
            body: graphqlRequestBody.map((payload) => ({
              ...payload,
              id: uuid(),
            })),
            bodySize: body.length,
          },
          native: {},
        })
      })
    },
    [setRequests]
  )

  const handleResponseReceived = useCallback(
    (params: any) => {
      const { requestId, response } = params as {
        requestId: string
        response: ICdpResponse
      }

      if (!response) {
        return
      }

      const headers = toHeaderList(response.headers)

      updateRequest(requestId, {
        status: response.status,
        response: {
          headers,
          headersSize: getHeadersSize(headers),
          body: '',
          bodySize: response.encodedDataLength || 0,
        },
      })
    },
    [updateRequest]
  )

  const handleLoadingFinished = useCallback(
    async (tabId: number, params: any) => {
      const { requestId, timestamp, encodedDataLength } = params as {
        requestId: string
        timestamp: number
        encodedDataLength: number
      }

      const existing = getLatestRequests().find(
        (request) => request.id === requestId
      )
      if (!existing) {
        return
      }

      const startedAt = startTimesRef.current.get(requestId)
      const time = startedAt ? (timestamp - startedAt) * 1000 : 0

      const result = await sendDebuggerCommand<{
        body: string
        base64Encoded: boolean
      }>(tabId, 'Network.getResponseBody', { requestId })

      let raw = ''
      if (result) {
        raw = result.base64Encoded ? atob(result.body) : result.body || ''
      }

      const headers = existing.response?.headers || []
      const split = splitResponseBody(headers, raw)

      updateRequest(requestId, {
        time,
        response: {
          headers,
          headersSize: existing.response?.headersSize || 0,
          body: split.body,
          bodySize: encodedDataLength || raw.length,
          chunks: split.chunks,
          isStreaming: split.isStreaming,
        },
      })

      startTimesRef.current.delete(requestId)
    },
    [getLatestRequests, updateRequest]
  )

  const handleLoadingFailed = useCallback(
    (params: any) => {
      const { requestId } = params as { requestId: string }

      updateRequest(requestId, { status: 0 })
      startTimesRef.current.delete(requestId)
    },
    [updateRequest]
  )

  useEffect(() => {
    // Attaching the debugger makes Chrome show a banner on the page, so
    // the panel only holds a session while recording is switched on.
    if (!isEnabled) {
      return
    }

    const chrome = chromeProvider()
    const tabId = chrome.devtools.inspectedWindow.tabId

    const removeListener = addDebuggerListener((method, params) => {
      if (method === 'Network.requestWillBeSent') {
        handleRequestWillBeSent(tabId, params)
      } else if (method === 'Network.responseReceived') {
        handleResponseReceived(params)
      } else if (method === 'Network.loadingFinished') {
        handleLoadingFinished(tabId, params)
      } else if (method === 'Network.loadingFailed') {
        handleLoadingFailed(params)
      }
    })

    const startSession = async (isFirstAttach: boolean) => {
      const isAttached = isFirstAttach
        ? await attachDebugger(tabId)
        : await ensureDebuggerAttached(tabId)

      if (!isAttached) {
        return
      }

      // maxPostDataSize asks Chrome to put the request body straight into
      // requestWillBeSent. Without it only a hasPostData flag arrives.
      await sendDebuggerCommand(tabId, 'Network.enable', {
        maxPostDataSize: MAX_POST_DATA_SIZE,
      })
    }

    // Chrome drops the attachment on some navigations, which ends every
    // event without warning. Attach again whenever that happens.
    const removeDetachListener = addDetachListener(() => {
      startSession(false)
    })

    // A detach is not always reported, so check the session as well
    const sessionCheck = setInterval(() => {
      if (!isDebuggerAttached()) {
        startSession(false)
      }
    }, SESSION_CHECK_INTERVAL)

    startSession(true)

    return () => {
      clearInterval(sessionCheck)
      removeDetachListener()
      removeListener()
      detachDebugger(tabId)
    }
  }, [
    isEnabled,
    handleRequestWillBeSent,
    handleResponseReceived,
    handleLoadingFinished,
    handleLoadingFailed,
  ])

  const clearRequests = useCallback(
    (opts?: IClearWebRequestsOptions) => {
      const { clearPending = true, clearAll = true } = opts || {}

      if (clearAll) {
        setRequests([])
        return
      }

      if (clearPending) {
        setRequests((previous) =>
          previous.filter((request) => request.response !== undefined)
        )
      }
    },
    [setRequests]
  )

  return [requests, clearRequests]
}
