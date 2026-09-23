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
import { logDiagnostic, bumpCounter, setInfo } from '../services/diagnostics'
import useLatestState from './useLatestState'
import { IClearWebRequestsOptions } from './useNetworkMonitor'

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
 * Split a response body into chunks when the response is delivered in
 * parts, which happens with the @defer and @stream directives and with
 * subscriptions sent over a single connection.
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
    logDiagnostic('splitResponseBodyFailed', { message: String(e) })
  }

  return { body, isStreaming: false }
}

/**
 * Collect GraphQL requests over the Chrome DevTools Protocol.
 *
 * The devtools network api cannot be used for this on Chrome 152 and
 * later. It leaves the request body out of every entry, it never reports a
 * finished event for a cross origin POST, and `getContent` returns null.
 * The protocol reports the same traffic with a stable request id, so the
 * request and the response never have to be paired by guesswork.
 */
export const useDebuggerNetworkMonitor = (): [
  ICompleteNetworkRequest[],
  (opts?: IClearWebRequestsOptions) => void
] => {
  const [requests, setRequests, getLatestRequests] = useLatestState<
    ICompleteNetworkRequest[]
  >([])

  // Requests that have started but are not yet shown, keyed by the
  // protocol's request id
  const startTimesRef = useRef(new Map<string, number>())

  const upsertRequest = useCallback(
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

      if (!request || isPreflightRequest(request.method)) {
        return
      }

      bumpCounter('cdpRequest')
      const isGraphqlUrl = request.url?.includes('graphql')
      if (isGraphqlUrl) {
        bumpCounter('cdpReqGql')
      }

      const describe = (outcome: string, extra = '') =>
        setInfo(
          'cdpReq',
          `${request.method} ${request.url?.slice(0, 60)} hasPostData=${
            request.hasPostData
          } inline=${Boolean(request.postData)} ${outcome} ${extra}`
        )

      let postData = request.postData
      if (!postData && request.hasPostData) {
        const result = await sendDebuggerCommand<{ postData: string }>(
          tabId,
          'Network.getRequestPostData',
          { requestId }
        )
        postData = result?.postData
        if (isGraphqlUrl) {
          bumpCounter(postData ? 'cdpFetchedPostData' : 'cdpFetchPostDataFailed')
        }
      }

      if (!postData) {
        if (isGraphqlUrl) {
          describe('rejected=noPostData')
        }
        return
      }

      // Hold the body in a const so its type survives into the closure below
      const body = postData
      const graphqlRequestBody = parseGraphqlBody(body)
      if (!graphqlRequestBody) {
        describe('rejected=notGraphql', `len=${body.length}`)
        return
      }

      const primaryOperation = getFirstGraphqlOperation(graphqlRequestBody)
      if (!primaryOperation) {
        describe('rejected=noOperation', `len=${body.length}`)
        return
      }

      describe('accepted', `op=${primaryOperation.operationName}`)

      bumpCounter('cdpGraphql')
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
            body: graphqlRequestBody.map((body) => ({ ...body, id: uuid() })),
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

      bumpCounter('cdpResponse')
      const headers = toHeaderList(response.headers)

      upsertRequest(requestId, {
        status: response.status,
        response: {
          headers,
          headersSize: getHeadersSize(headers),
          body: '',
          bodySize: response.encodedDataLength || 0,
        },
      })
    },
    [upsertRequest]
  )

  const handleLoadingFinished = useCallback(
    async (tabId: number, params: any) => {
      const { requestId, timestamp, encodedDataLength } = params as {
        requestId: string
        timestamp: number
        encodedDataLength: number
      }

      bumpCounter('cdpFinished')

      const existing = getLatestRequests().find(
        (request) => request.id === requestId
      )
      if (!existing) {
        return
      }

      bumpCounter('cdpFinishedTracked')

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

      if (raw) {
        bumpCounter('cdpBody')
      }

      setInfo(
        'cdpBody',
        `id=${requestId} len=${raw.length} time=${Math.round(time)}ms status=${
          existing.status
        }`
      )
      logDiagnostic('cdpResponseBody', {
        requestId,
        url: existing.url,
        length: raw.length,
        gotResult: Boolean(result),
      })

      const headers = existing.response?.headers || []
      const split = splitResponseBody(headers, raw)

      upsertRequest(requestId, {
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
    [getLatestRequests, upsertRequest]
  )

  const handleLoadingFailed = useCallback(
    (params: any) => {
      const { requestId, errorText } = params as {
        requestId: string
        errorText?: string
      }

      logDiagnostic('cdpLoadingFailed', { requestId, errorText })
      upsertRequest(requestId, { status: 0 })
      startTimesRef.current.delete(requestId)
    },
    [upsertRequest]
  )

  useEffect(() => {
    const chrome = chromeProvider()
    const tabId = chrome.devtools.inspectedWindow.tabId

    bumpCounter('cdpSetup')

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

    const enableNetwork = async (isFirstAttach: boolean) => {
      const isAttached = isFirstAttach
        ? await attachDebugger(tabId)
        : await ensureDebuggerAttached(tabId)

      setInfo('cdpAttached', String(isAttached))
      logDiagnostic('cdpAttach', { tabId, isAttached, isFirstAttach })

      if (!isAttached) {
        return
      }

      // maxPostDataSize asks Chrome to put the request body straight into
      // requestWillBeSent. Without it only a hasPostData flag arrives.
      const enabled = await sendDebuggerCommand(tabId, 'Network.enable', {
        maxPostDataSize: 5 * 1024 * 1024,
      })
      setInfo('cdpEnabled', enabled === undefined ? 'failed' : 'ok')
      logDiagnostic('cdpNetworkEnabled', {
        tabId,
        enabled: enabled !== undefined,
      })
    }

    // Chrome drops the attachment on some navigations, which silently ends
    // every event. Attach again whenever that happens.
    const removeDetachListener = addDetachListener(() => {
      bumpCounter('cdpReattach')
      setTimeout(() => enableNetwork(false), 200)
    })

    // A detach is not always reported, so check the session as well.
    const watchdog = setInterval(() => {
      if (!isDebuggerAttached()) {
        bumpCounter('cdpWatchdog')
        enableNetwork(false)
      }
    }, 2000)

    enableNetwork(true)

    return () => {
      bumpCounter('cdpTeardown')
      clearInterval(watchdog)
      removeDetachListener()
      removeListener()
      detachDebugger(tabId)
    }
  }, [
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

  setInfo(
    'cdpRows',
    `rows=${requests.length} withStatus=${
      requests.filter((request) => request.status !== -1).length
    } withBody=${requests.filter((request) => request.response?.body).length}`
  )

  return [requests, clearRequests]
}
