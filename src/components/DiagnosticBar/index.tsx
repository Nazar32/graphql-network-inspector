import { useEffect, useState } from 'react'
import { diagnosticCounters } from '../../services/diagnostics'

/**
 * Show the live event counters at the bottom of the panel.
 *
 * This exists only to investigate issue #204. Remove it once the cause is
 * known.
 */
const DiagnosticBar = () => {
  const [, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick((tick) => tick + 1), 500)
    return () => clearInterval(id)
  }, [])

  const counters = diagnosticCounters
  const text = [
    `before:${counters.before}`,
    `finished:${counters.finished}`,
    `gate:${counters.gate}`,
    `content:${counters.content}`,
    `matched:${counters.matched}`,
    `postData:${counters.postData}`,
    `har:${counters.har}`,
  ].join('  ')

  return (
    <div className="fixed bottom-4 left-6 text-md font-mono text-yellow-500 z-50">
      DIAG {text}
    </div>
  )
}

export default DiagnosticBar
