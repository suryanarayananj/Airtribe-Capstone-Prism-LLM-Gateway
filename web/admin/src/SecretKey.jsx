import { useState } from 'react';

function maskSecret(value) {
  if (!value) {
    return '—';
  }
  // Fixed mask so secret length is not leaked in the UI.
  return 'prism-sk-••••••••••••';
}

export function SecretKey({ value, initiallyVisible = false }) {
  const [visible, setVisible] = useState(Boolean(initiallyVisible));
  if (!value) {
    return <span className="mono">—</span>;
  }

  return (
    <span className="secret-key">
      <span className="mono">{visible ? value : maskSecret(value)}</span>
      <button
        type="button"
        className="secret-key-toggle"
        aria-label={visible ? 'Hide secret' : 'Show secret'}
        title={visible ? 'Hide' : 'Show'}
        onClick={() => setVisible((prev) => !prev)}
      >
        {visible ? (
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"
            />
            <path
              fill="currentColor"
              d="M3.5 3.5 20.5 20.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"
            />
          </svg>
        )}
      </button>
    </span>
  );
}
