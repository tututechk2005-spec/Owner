// Thin fetch wrapper. Token is kept in localStorage AND sent as an
// httpOnly cookie by the server on login/register, so requests work either
// way; localStorage token is used for the Authorization header so pages
// opened directly still authenticate correctly.
const Api = (() => {
  function token() {
    return localStorage.getItem('token');
  }

  function adminToken() {
    return localStorage.getItem('admin_token');
  }

  async function request(method, url, body, useAdmin = false) {
    const headers = { 'Content-Type': 'application/json' };
    const t = useAdmin ? adminToken() : token();
    if (t) headers['Authorization'] = `Bearer ${t}`;

    const res = await fetch(url, {
      method,
      headers,
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let data;
    try { data = await res.json(); } catch (e) { data = {}; }

    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.detail = data;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    get: (url, useAdmin) => request('GET', url, undefined, useAdmin),
    post: (url, body, useAdmin) => request('POST', url, body || {}, useAdmin),
    put: (url, body, useAdmin) => request('PUT', url, body || {}, useAdmin),
    del: (url, useAdmin) => request('DELETE', url, undefined, useAdmin),
    token,
    adminToken,
  };
})();
