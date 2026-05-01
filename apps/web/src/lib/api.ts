export function getApiBase(): string {
  // In dev, Vite proxy handles /api. In production (Render static site),
  // we point at the API URL via VITE_API_BASE.
  return import.meta.env.VITE_API_BASE || ''
}

export async function apiPost<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await res.text())
  return (await res.json()) as T
}

export async function apiGet<T>(path: string, token?: string): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!res.ok) throw new Error(await res.text())
  return (await res.json()) as T
}

