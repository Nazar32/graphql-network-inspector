import { useCallback, useEffect, useRef, useState } from 'react'
import { chromeProvider } from '@/services/chromeProvider'
import { useSSEListener } from './useSSEListener'
import { useWebSocketListener } from './useWebSocketListener'
import { ITrackedConnection, ISubscriptionRequest } from './types'
import { connectionToRequest } from './utils'
import {
  attachDebugger,
  detachDebugger,
  sendDebuggerCommand,
} from '../../services/debuggerSession'

/** Maximum age in ms for closed connections before cleanup (5 minutes) */
const CONNECTION_CLEANUP_TIMEOUT_MS = 5 * 60 * 1000
/** Interval for running cleanup checks (1 minute) */
const CLEANUP_INTERVAL_MS = 60 * 1000

interface UseGraphqlSubscriptionsOptions {
  isEnabled: boolean
  urlFilter: string
}

/**
 * Monitors GraphQL subscription connections (WebSocket and SSE) using the
 * Chrome DevTools Protocol debugger API.
 *
 * Returns an array of subscription requests with their messages, and a
 * function to clear all tracked requests.
 *
 * @example
 * ```tsx
 * const [subscriptions, clearSubscriptions] = useGraphqlSubscriptions({
 *   isEnabled: true,
 *   urlFilter: 'graphql',
 * })
 * ```
 */
export const useGraphqlSubscriptions = (
  options: UseGraphqlSubscriptionsOptions = { isEnabled: true, urlFilter: '' }
) => {
  const [requests, setRequests] = useState<ISubscriptionRequest[]>([])
  const connectionsRef = useRef(new Map<string, ITrackedConnection>())
  const chrome = chromeProvider()

  const syncRequestsState = useCallback(() => {
    const filtered = Array.from(connectionsRef.current.values())
      .filter((conn) => {
        if (options.urlFilter && !conn.url.includes(options.urlFilter)) {
          return false
        }
        return conn.messages.length > 0
      })
      .map(connectionToRequest)

    setRequests(filtered)
  }, [options.urlFilter])

  // Attach Chrome debugger to enable network monitoring.
  //
  // The attachment is shared, because the network monitor needs the same
  // protocol session and Chrome allows only one attachment per tab.
  useEffect(() => {
    if (!options.isEnabled) return

    const tabId = chrome.devtools.inspectedWindow.tabId

    attachDebugger(tabId).then((isAttached) => {
      if (!isAttached) {
        return
      }

      sendDebuggerCommand(tabId, 'Network.enable')
    })

    return () => {
      detachDebugger(tabId)
    }
  }, [chrome, options.isEnabled])

  useWebSocketListener({
    isEnabled: options.isEnabled,
    connections: connectionsRef.current,
    onUpdate: syncRequestsState,
  })

  useSSEListener({
    isEnabled: options.isEnabled,
    connections: connectionsRef.current,
    onUpdate: syncRequestsState,
  })

  // Cleanup stale closed connections periodically to prevent memory leaks
  useEffect(() => {
    if (!options.isEnabled) return

    const cleanupStaleConnections = () => {
      const now = Date.now()
      const connections = connectionsRef.current

      Array.from(connections.entries()).forEach(([requestId, conn]) => {
        // Remove closed connections that have been inactive for too long
        if (
          conn.isClosed &&
          conn.lastActivityTime &&
          now - conn.lastActivityTime > CONNECTION_CLEANUP_TIMEOUT_MS
        ) {
          connections.delete(requestId)
        }
      })
    }

    const intervalId = setInterval(cleanupStaleConnections, CLEANUP_INTERVAL_MS)

    return () => {
      clearInterval(intervalId)
    }
  }, [options.isEnabled])

  const clearRequests = useCallback(() => {
    connectionsRef.current.clear()
    setRequests([])
  }, [])

  return [requests, clearRequests] as const
}
