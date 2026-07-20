export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      {onRetry ? <button type="button" className="text-button" onClick={onRetry}>重试</button> : null}
    </div>
  );
}
