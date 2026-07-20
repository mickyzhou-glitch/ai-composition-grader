export function ErrorBanner({ message, onRetry, retryLabel = "重试" }: { message: string; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      {onRetry ? <button type="button" className="text-button" onClick={onRetry}>{retryLabel}</button> : null}
    </div>
  );
}
