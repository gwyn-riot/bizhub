let token = localStorage.getItem('token');
export const setToken = (t) => { token = t; t ? localStorage.setItem('token', t) : localStorage.removeItem('token'); };
export const hasToken = () => !!token;

export async function api(path, method = 'GET', body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) },
    body: body && JSON.stringify(body),
  });
  if (res.status === 401 && token) { setToken(null); location.reload(); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Ошибка запроса');
  return res.status === 204 ? null : res.json();
}
