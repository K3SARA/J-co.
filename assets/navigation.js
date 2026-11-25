(() => {
  const nav = document.getElementById('site-navigation');
  const menuToggle = document.querySelector('.nav-toggle');
  const toolsToggle = document.querySelector('.nav-dropdown-toggle');
  const toolsMenu = document.getElementById('free-tools-menu');
  const dropdown = toolsToggle && toolsToggle.closest('.nav-dropdown');

  if (!nav || !menuToggle || !toolsToggle || !toolsMenu || !dropdown) return;

  function closeToolsMenu() {
    toolsToggle.setAttribute('aria-expanded', 'false');
    toolsMenu.hidden = true;
  }

  function closeNavigation() {
    nav.classList.remove('is-open');
    menuToggle.setAttribute('aria-expanded', 'false');
    closeToolsMenu();
  }

  toolsToggle.addEventListener('click', () => {
    const isOpen = toolsToggle.getAttribute('aria-expanded') === 'true';
    toolsToggle.setAttribute('aria-expanded', String(!isOpen));
    toolsMenu.hidden = isOpen;
  });

  menuToggle.addEventListener('click', () => {
    const isOpen = menuToggle.getAttribute('aria-expanded') === 'true';
    menuToggle.setAttribute('aria-expanded', String(!isOpen));
    nav.classList.toggle('is-open', !isOpen);
    if (isOpen) closeToolsMenu();
  });

  document.addEventListener('click', (event) => {
    if (!dropdown.contains(event.target)) closeToolsMenu();
    if (!nav.contains(event.target) && !menuToggle.contains(event.target)) {
      nav.classList.remove('is-open');
      menuToggle.setAttribute('aria-expanded', 'false');
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeNavigation();
  });

  nav.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', closeNavigation);
  });
})();
