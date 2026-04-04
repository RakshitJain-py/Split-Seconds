'use client'
import { useState, useEffect, useRef } from 'react'

interface Props {
  initialCode: string
}

export default function LinkForm({ initialCode }: Props) {
  const [code, setCode] = useState(initialCode.toUpperCase())
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const submitted = useRef(false)

  async function submitCode(codeToSubmit: string) {
    if (submitted.current) return
    submitted.current = true
    setStatus('loading')

    try {
      const res = await fetch('/api/link-group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: codeToSubmit.trim().toUpperCase() })
      })

      const data = await res.json()
      if (res.ok) {
        setStatus('success')
        setMessage(data.message || 'Group linked successfully!')
      } else {
        setStatus('error')
        setMessage(data.error || 'Something went wrong')
        submitted.current = false
      }
    } catch {
      setStatus('error')
      setMessage('Network error. Please try again.')
      submitted.current = false
    }
  }

  // Auto-submit when a valid code is pre-filled from the URL
  useEffect(() => {
    if (initialCode.length === 8) {
      submitCode(initialCode.toUpperCase())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    submitted.current = false // allow re-submit from form
    await submitCode(code)
  }

  return (
    <main style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0f0f0f',
      fontFamily: 'system-ui, -apple-system, sans-serif'
    }}>
      <div style={{
        width: '100%',
        maxWidth: 420,
        margin: '0 20px',
        background: '#1a1a1a',
        border: '1px solid #2a2a2a',
        borderRadius: 16,
        padding: '40px 32px'
      }}>
        {/* Logo mark */}
        <div style={{
          width: 48,
          height: 48,
          background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
          borderRadius: 12,
          marginBottom: 24,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 24
        }}>⚡</div>

        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#fff', margin: '0 0 8px' }}>
          Link your group
        </h1>
        <p style={{ color: '#666', margin: '0 0 32px', fontSize: 14, lineHeight: 1.5 }}>
          Enter the code from your Telegram group to activate SplitSeconds.
        </p>

        {status === 'loading' && (
          <div style={{
            background: 'rgba(99,102,241,0.1)',
            border: '1px solid rgba(99,102,241,0.3)',
            padding: '16px 20px',
            borderRadius: 10,
            textAlign: 'center'
          }}>
            <p style={{ color: '#818cf8', margin: 0, fontSize: 15 }}>Linking your group…</p>
          </div>
        )}

        {status === 'success' && (
          <div style={{
            background: 'rgba(34,197,94,0.1)',
            border: '1px solid rgba(34,197,94,0.3)',
            padding: '16px 20px',
            borderRadius: 10
          }}>
            <p style={{ color: '#4ade80', margin: 0, fontSize: 15, fontWeight: 500 }}>
              ✓ {message}
            </p>
            <p style={{ color: '#555', margin: '8px 0 0', fontSize: 13 }}>
              Check your Telegram group — it&apos;s ready to go.
            </p>
          </div>
        )}

        {(status === 'idle' || status === 'error') && (
          <form onSubmit={handleSubmit}>
            <label style={{ display: 'block', color: '#888', fontSize: 12, fontWeight: 600, letterSpacing: '0.05em', marginBottom: 8 }}>
              GROUP CODE
            </label>
            <input
              id="link-code-input"
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              placeholder="e.g. AB12CD34"
              style={{
                width: '100%',
                padding: '12px 14px',
                fontSize: 18,
                fontWeight: 600,
                letterSpacing: '0.1em',
                background: '#111',
                border: `1px solid ${status === 'error' ? '#ef4444' : '#2a2a2a'}`,
                borderRadius: 8,
                color: '#fff',
                outline: 'none',
                boxSizing: 'border-box',
                marginBottom: 12
              }}
              maxLength={8}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              required
            />

            {status === 'error' && (
              <p style={{ color: '#ef4444', margin: '0 0 12px', fontSize: 13 }}>
                ⚠ {message}
              </p>
            )}

            <button
              id="link-submit-btn"
              type="submit"
              disabled={code.length !== 8}
              style={{
                width: '100%',
                padding: '13px 16px',
                background: code.length === 8
                  ? 'linear-gradient(135deg, #6366f1, #8b5cf6)'
                  : '#2a2a2a',
                color: code.length === 8 ? '#fff' : '#555',
                border: 'none',
                borderRadius: 8,
                fontSize: 15,
                fontWeight: 600,
                cursor: code.length === 8 ? 'pointer' : 'not-allowed',
                transition: 'all 0.2s',
                boxSizing: 'border-box'
              }}
            >
              Link Group →
            </button>
          </form>
        )}
      </div>
    </main>
  )
}
