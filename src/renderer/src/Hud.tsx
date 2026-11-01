import { useEffect, useState } from 'react'

/** Rear view of a pixel sports car, because every road needs one. */
function Car() {
  return (
    <svg className="car" viewBox="0 0 32 18" shapeRendering="crispEdges" aria-hidden="true">
      <rect x="3" y="15" width="26" height="2" fill="#05010f" opacity=".6" />
      <rect x="2" y="11" width="5" height="6" fill="#0c0618" /><rect x="25" y="11" width="5" height="6" fill="#0c0618" />
      <rect x="6" y="0" width="20" height="2" fill="#ff2a4a" /><rect x="6" y="2" width="2" height="3" fill="#c81d3a" /><rect x="24" y="2" width="2" height="3" fill="#c81d3a" />
      <polygon points="8,3 24,3 27,9 5,9" fill="#c81d3a" />
      <rect x="10" y="4" width="12" height="4" fill="#19f0ff" opacity=".9" /><rect x="10" y="4" width="12" height="1" fill="#fff" opacity=".6" />
      <rect x="3" y="9" width="26" height="6" fill="#ff2a4a" /><rect x="3" y="9" width="26" height="1" fill="#ff7a96" />
      <rect x="4" y="10" width="5" height="2" fill="#ffe14d" /><rect x="23" y="10" width="5" height="2" fill="#ffe14d" />
      <rect x="12" y="12" width="8" height="2" fill="#7a0f26" />
    </svg>
  )
}

/** Live counts, shown the way an arcade shows a score. */
export function Hud({ refreshKey }: { refreshKey: string }) {
  const [n, setN] = useState({ queue: 0, sent: 0, hits: 0 })
  useEffect(() => {
    Promise.all([window.api.listJobs('active'), window.api.listApplications()]).then(([jobs, apps]) => {
      const sent = apps.filter((a) => a.attempt_status === 'submitted')
      setN({ queue: jobs.length, sent: sent.length, hits: sent.filter((a) => ['screen', 'interview', 'offer'].includes(a.response_status ?? '')).length })
    }).catch(() => {})
  }, [refreshKey])
  const pad = (v: number): string => String(v).padStart(3, '0')
  return (
    <footer className="hud">
      <div className="stat"><span>QUEUE</span><b>{pad(n.queue)}</b></div>
      <Car />
      <div className="stat right"><span>SENT</span><b>{pad(n.sent)}</b><span>HITS</span><b>{pad(n.hits)}</b></div>
    </footer>
  )
}
