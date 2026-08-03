'use strict';
// Injects sidebar + topbar + bottom-nav into every dashboard page.
// Each page needs: <div id="app-shell"> wrapping <div id="page-content">...</div>

const NAV = [
  { href:'/dashboard.html',     label:'Dashboard',    icon:'grid' },
  { href:'/markets.html',       label:'Markets',      icon:'chart' },
  { href:'/auto-trading.html',  label:'Auto Trade',   icon:'bot' },
  { href:'/manual-trading.html',label:'Trade',        icon:'trade' },
  { href:'/signals.html',       label:'Signals',      icon:'signal' },
  { href:'/analytics.html',     label:'Analytics',    icon:'analytics' },
  { href:'/history.html',       label:'History',      icon:'history' },
  { href:'/wallet.html',        label:'Wallet',       icon:'wallet' },
  { href:'/referral.html',      label:'Referral',     icon:'gift' },
  { href:'/notifications.html', label:'Alerts',       icon:'bell' },
  { href:'/support.html',       label:'Support',      icon:'support' },
  { href:'/settings.html',      label:'Settings',     icon:'settings' },
  { href:'/profile.html',       label:'Profile',      icon:'user' },
];

// Bottom nav: Dashboard | Markets | Trade (center) | Wallet | Profile
const BOTTOM_NAV = [
  { href:'/dashboard.html',  label:'Home',    icon:'grid' },
  { href:'/markets.html',    label:'Markets', icon:'chart' },
  { href:'/manual-trading.html', label:'Trade', icon:'trade', center:true },
  { href:'/wallet.html',     label:'Assets',  icon:'wallet' },
  { href:'/profile.html',    label:'Profile', icon:'user' },
];

const ICONS = {
  grid:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
  chart:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 16l4-4 3 3 5-6"/></svg>`,
  bot:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2"/><circle cx="9" cy="14" r="1" fill="currentColor"/><circle cx="15" cy="14" r="1" fill="currentColor"/><path d="M12 8V4M9 4h6"/><path d="M8 20v2M16 20v2"/></svg>`,
  trade:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 16V4m0 0L3 8m4-4l4 4"/><path d="M17 8v12m0 0l4-4m-4 4l-4-4"/></svg>`,
  signal:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20h2M6 15h2M10 10h2M14 5h2M18 2h2"/><path d="M4 20v-5M8 15v-7M12 10V3M16 5v10M20 2v13"/></svg>`,
  analytics:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M20 9l-5 5-3-3-4 5"/></svg>`,
  history:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/><path d="M12 7v5l4 2"/></svg>`,
  wallet:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20"/><circle cx="17" cy="15" r="1" fill="currentColor"/></svg>`,
  gift:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="9" width="18" height="12" rx="1"/><path d="M3 9h18M12 9v12M12 9c0-2 2-4 4-4s2 4-4 4M12 9c0-2-2-4-4-4s-2 4 4 4"/></svg>`,
  bell:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>`,
  support:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2.5-2.5 4"/><circle cx="12" cy="17" r=".5" fill="currentColor"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  user:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  logo:     `<svg viewBox="0 0 24 24" fill="#1a1200"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`,
  menu:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>`,
  search:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>`,
};

function buildShell() {
  const shell = document.getElementById('app-shell');
  if (!shell) return;
  const content = document.getElementById('page-content');
  const inner = content ? content.innerHTML : '';
  const cur = window.location.pathname;

  const isActive = (href) => cur.endsWith(href) || cur.endsWith(href.replace('.html',''));

  const sidebarLinks = NAV.map(n => `
    <a class="nav-link ${isActive(n.href) ? 'active' : ''}" href="${n.href}">
      ${ICONS[n.icon]}<span>${n.label}</span>
    </a>`).join('');

  const bottomLinks = BOTTOM_NAV.map(n => {
    if (n.center) {
      return `<a class="bottom-nav-item trade-btn ${isActive(n.href) ? 'active' : ''}" href="${n.href}">
        <div class="trade-icon">${ICONS[n.icon]}</div>
        <span>${n.label}</span>
      </a>`;
    }
    return `<a class="bottom-nav-item ${isActive(n.href) ? 'active' : ''}" href="${n.href}">
      ${ICONS[n.icon]}<span>${n.label}</span>
    </a>`;
  }).join('');

  shell.innerHTML = `
    <div class="sidebar-overlay" id="sidebar-overlay"></div>
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-logo">
        <div class="logo-icon">${ICONS.logo}</div>
        AI Trader
      </div>
      <div class="nav-section">Main</div>
      ${sidebarLinks}
      <div class="sidebar-bottom">
        <button class="btn btn-secondary btn-sm btn-block" onclick="logout()" style="margin-top:8px;">Log out</button>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <div class="topbar-left">
          <button class="hamburger" id="hamburger-btn" aria-label="Open menu">
            ${ICONS.menu}
          </button>
          <div class="topbar-search">
            ${ICONS.search}
            <input placeholder="Search markets, symbols..." aria-label="Search" />
          </div>
        </div>
        <div class="topbar-right">
          <div class="status-pill">
            <span class="dot dot-green pulse"></span> Live
          </div>
          <a href="/notifications.html" class="topbar-icon-btn" aria-label="Notifications">${ICONS.bell}</a>
          <a href="/profile.html" class="topbar-avatar" id="user-avatar" aria-label="Profile">U</a>
        </div>
      </header>

      <div class="page-content" id="page-content-inner">
        ${inner}
      </div>
    </div>

    <nav class="bottom-nav" aria-label="Main navigation">
      <div class="bottom-nav-inner">${bottomLinks}</div>
    </nav>
  `;

  // Hamburger toggle (mobile sidebar)
  const hamburger = document.getElementById('hamburger-btn');
  const sidebar   = document.getElementById('sidebar');
  const overlay   = document.getElementById('sidebar-overlay');
  if (hamburger && sidebar && overlay) {
    hamburger.addEventListener('click', () => {
      sidebar.classList.toggle('mobile-open');
      overlay.classList.toggle('open');
    });
    overlay.addEventListener('click', () => {
      sidebar.classList.remove('mobile-open');
      overlay.classList.remove('open');
    });
  }
}

document.addEventListener('DOMContentLoaded', buildShell);

// Set avatar initial from user name
document.addEventListener('user-ready', (e) => {
  const av = document.getElementById('user-avatar');
  if (av && e.detail && e.detail.name) {
    av.textContent = e.detail.name.trim()[0].toUpperCase();
  }
});
