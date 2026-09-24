// Сховище на Netlify Blobs. Для тестів можна підставити globalThis.__ASO_STORE (in-memory).
import { getStore } from '@netlify/blobs';
export function store(name) {
  if (globalThis.__ASO_STORE) return globalThis.__ASO_STORE(name);
  return getStore({ name, consistency: 'strong' });
}
