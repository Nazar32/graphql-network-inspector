import { useEffect, useState } from 'react'
import { diagnosticCounters, diagnosticInfo } from '../../services/diagnostics'

/**
 * Show the live event counters and the raw values of the most recent
 * GraphQL request at the top of the panel.
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
  const totals = [
    `before:${counters.before}`,
    `finished:${counters.finished}`,
    `gate:${counters.gate}`,
    `content:${counters.content}`,
    `matched:${counters.matched}`,
    `postData:${counters.postData}`,
    `har:${counters.har}`,
    `applied:${counters.applied || 0}`,
    `cleared:${counters.cleared || 0}`,
    `nav:${counters.navigated || 0}`,
    `harSet:${counters.harSet || 0}`,
  ].join('  ')

  return (
    <div className="fixed top-0 left-0 right-0 bg-black text-yellow-400 font-mono text-xs p-2 z-50 break-all border-b border-yellow-700">
      <div>DIAG {totals}</div>
      <div>FINISHED {diagnosticInfo.finished}</div>
      <div>CONTENT {diagnosticInfo.content}</div>
      <div>ROWS {diagnosticInfo.rows}</div>
      <div>GQL {diagnosticInfo.gql}</div>
      <div>MATCH {diagnosticInfo.match}</div>
      <div>CHOSEN {diagnosticInfo.chosen}</div>
      <div>
        CLEAR {diagnosticInfo.cleared} | HARSET {diagnosticInfo.harSet}
      </div>
    </div>
  )
}

export default DiagnosticBar
