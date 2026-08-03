// Include on every protected (dashboard-area) page. Redirects to login if
// no token is present, and exposes window.currentUser once loaded.
(async function () {
  const token = localStorage.getItem('token');
  if (!token) {
    window.location.href = '/login.html';
    return;
  }
  try {
    const { user } = await Api.get('/api/auth/me');
    window.currentUser = user;
    document.dispatchEvent(new CustomEvent('user-ready', { detail: user }));
  } catch (e) {
    localStorage.removeItem('token');
    window.location.href = '/login.html';
  }
})();

function logout() {
  Api.post('/api/auth/logout').finally(() => {
    localStorage.removeItem('token');
    window.location.href = '/login.html';
  });
}
