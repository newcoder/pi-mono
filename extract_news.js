(() => {
  const items = document.querySelectorAll('[class*="telegraph"]');
  const texts = [];
  for (let i = 0; i < items.length && texts.length < 20; i++) {
    const t = items[i].innerText?.trim();
    if (t && t.length > 20) texts.push(t);
  }
  return texts.slice(0, 10);
})()
