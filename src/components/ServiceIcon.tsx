export default function ServiceIcon({ service, size = 24 }: { service: 'spotify' | 'youtube'; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    {service === 'spotify' ? <>
      <circle cx="12" cy="12" r="10" fill="currentColor"/>
      <path d="M6.5 9c3.7-1.2 7.5-.9 11 1M7.2 12.3c3.1-1 6.4-.7 9.3.9M8 15.5c2.6-.7 5.1-.5 7.6.7" stroke="var(--service-ink, #142019)" strokeWidth="1.55" strokeLinecap="round"/>
    </> : <>
      <circle cx="12" cy="12" r="10" fill="currentColor"/>
      <circle cx="12" cy="12" r="7" stroke="var(--service-ink, #241619)" strokeWidth="1"/>
      <path d="m10 8 6 4-6 4V8Z" fill="var(--service-ink, #241619)"/>
    </>}
  </svg>;
}
