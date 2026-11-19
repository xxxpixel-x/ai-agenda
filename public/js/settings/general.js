import { applyTheme, theme } from '../sidebar.js';
import { register } from '../slots.js';
import { $, $$, ICON, api, esc, state, toast, tr } from '../util.js';

async function render(el) {
  let settings;
  try { settings = await api('/api/settings'); }
  catch (e) { toast(e.message, 'error'); return; }

  const languages = [['system', tr('跟随系统')], ['zh', '中文'], ['en', 'English']];
  const themes = [['system', tr('跟随系统')], ['light', tr('浅色')], ['dark', tr('深色')]];
  const toggles = [['notify', tr('AI 做完或等你处理时提醒我')], ['keepAwake', tr('AI 工作时不让电脑睡眠')]];
  el.innerHTML = `<section class="set-group">
    <div class="set-row">
      <label class="set-label" for="appLanguage">${esc(tr('语言'))}</label>
      <div class="set-control"><select id="appLanguage">
        ${languages.map(([value, label]) => `<option value="${esc(value)}" ${value === settings.language ? 'selected' : ''}>${esc(label)}</option>`).join('')}
      </select></div>
    </div>
    <div class="set-row">
      <span class="set-label">${esc(tr('外观'))}</span>
      <div class="set-control"><div class="seg" role="radiogroup" aria-label="${esc(tr('外观'))}">
        ${themes.map(([value, label]) => `<button type="button" class="seg-btn" role="radio" data-theme-opt="${esc(value)}">${esc(label)}</button>`).join('')}
      </div></div>
    </div>
    ${state.app.desktop ? toggles.map(([key, label]) => `<div class="set-row">
      <span class="set-label" id="${esc(key)}-label">${esc(label)}</span>
      <div class="set-control"><label class="switch">
        <input type="checkbox" role="switch" aria-labelledby="${esc(key)}-label" data-toggle="${esc(key)}" ${settings[key] ? 'checked' : ''}><i aria-hidden="true"></i>
      </label></div>
    </div>`).join('') : ''}
  </section>`;

  const buttons = $$('[data-theme-opt]', el);
  function syncTheme() {
    for (const button of buttons) {
      const selected = button.dataset.themeOpt === theme;
      button.classList.toggle('on', selected);
      button.setAttribute('aria-checked', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
  }
  syncTheme();
  for (const [index, button] of buttons.entries()) {
    button.onclick = () => { applyTheme(button.dataset.themeOpt); syncTheme(); };
    button.onkeydown = (event) => {
      const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const next = buttons[(index + step + buttons.length) % buttons.length];
      next.click();
      next.focus();
    };
  }

  $('#appLanguage', el).onchange = async ({ target }) => {
    target.disabled = true;
    try {
      await api('/api/settings', { method: 'PUT', body: { language: target.value } });
      location.reload();
    } catch (e) {
      target.value = settings.language || 'system';
      target.disabled = false;
      toast(e.message, 'error');
    }
  };
  for (const box of $$('[data-toggle]', el)) {
    box.closest('.set-row').onclick = (event) => {
      if (!event.target.closest('.switch')) box.click();
    };
    box.onchange = async () => {
      box.disabled = true;
      try { await api('/api/settings', { method: 'PUT', body: { [box.dataset.toggle]: box.checked } }); }
      catch (e) { box.checked = !box.checked; toast(e.message, 'error'); }
      finally { box.disabled = false; }
    };
  }
}

register('settings', { id: 'general', label: tr('通用'), icon: ICON.settings, order: 10, render });
