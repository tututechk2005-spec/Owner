(async function () {
  const token = localStorage.getItem('admin_token');
  if (!token) {
    window.location.href = '/admin-login.html';
    return;
  }
  try {
    await Api.get('/api/admin/stats', true);
  } catch (e) {
    localStorage.removeItem('admin_token');
    window.location.href = '/admin-login.html';
  }
})();

function adminLogout() {
  localStorage.removeItem('admin_token');
  window.location.href = '/admin-login.html';
}
