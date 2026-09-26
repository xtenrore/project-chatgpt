(() => {
  'use strict'

  const menu = document.getElementById('mobileMenu')
  const sidebar = document.getElementById('appSidebar') || document.querySelector('.sidebar')
  if (!menu || !sidebar) return

  const backdrop = document.createElement('div')
  backdrop.className = 'mobile-nav-backdrop'
  backdrop.setAttribute('aria-hidden', 'true')
  document.body.appendChild(backdrop)

  function isMobile() {
    return window.matchMedia('(max-width: 680px)').matches
  }

  function setOpen(open) {
    if (!isMobile() && open) return
    sidebar.classList.toggle('mobile-open', open)
    backdrop.classList.toggle('visible', open)
    document.body.classList.toggle('mobile-nav-open', open)
    menu.setAttribute('aria-expanded', open ? 'true' : 'false')
    backdrop.setAttribute('aria-hidden', open ? 'false' : 'true')
  }

  function close() { setOpen(false) }

  menu.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    setOpen(!sidebar.classList.contains('mobile-open'))
  })

  backdrop.addEventListener('click', close)

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') close()
  })

  sidebar.addEventListener('click', event => {
    if (!isMobile()) return
    const target = event.target.closest('.nav-item, .history-item, #newChatBtn, #accountBtn')
    if (target) close()
  })

  window.addEventListener('resize', () => {
    if (!isMobile()) close()
  }, { passive: true })
})()
