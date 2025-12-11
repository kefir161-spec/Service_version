// === i18n / language module ==========================================
(function (global, doc) {
  // Supported languages
  var SUPPORTED = ['en', 'ru'];

  function normalizeLang(code) {
    if (!code) return 'en';
    code = String(code).toLowerCase();
    if (code.indexOf('-') !== -1) code = code.split('-')[0];
    return SUPPORTED.indexOf(code) !== -1 ? code : 'en';
  }

  function getLangFromQuery() {
    var m = global.location.search.match(/[?&]lang=([a-zA-Z\-]+)/);
    return m ? m[1] : null;
  }

  // Default to EN, override only by ?lang=
  var currentLang = normalizeLang(getLangFromQuery() || 'en');

  // reflect in html tag
  try {
    doc.documentElement.setAttribute('lang', currentLang);
    doc.documentElement.setAttribute('data-lang', currentLang);
  } catch(e){}

  // Dictionaries
  var DICT = {
    en: {
      'app.title': '3D Builder',
      'loader.loading': 'Loading Cubiks...',

      'help.title': 'Quick start',
      'help.navigation': 'Navigation',
      'help.btn': 'Help',
      'help.start': 'Start',

      'hud.load': 'Load',
      'hud.save': 'Save',
      'hud.cubiks': 'Cubiks',
      'hud.cubiksLabel': 'Cubiks in scene',

      'nav.home': 'Home',
      'nav.shop': 'Shop',
      'nav.about': 'About us',
      'nav.faq': 'FAQ',
      'nav.gallery': 'Gallery',
      'nav.video': 'Video',
      'nav.blog': 'Blog',
      'nav.partnership': 'Partnership',
      'nav.contacts': 'Contacts'
    },

    ru: {
      'app.title': '\u0417\u0434\u0435\u0441\u044c \u043c\u043e\u0436\u043d\u043e \u0441\u043e\u0431\u0438\u0440\u0430\u0442\u044c Cubiks', // можно поменять на нужный
      'loader.loading': '\u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0430 Cubiks...',

      'help.title': '\u0411\u044b\u0441\u0442\u0440\u044b\u0439 \u0441\u0442\u0430\u0440\u0442',
      'help.navigation': '\u041d\u0430\u0432\u0438\u0433\u0430\u0446\u0438\u044f',
      'help.btn': '\u041f\u043e\u043c\u043e\u0449\u044c',
      'help.start': '\u041d\u0430\u0447\u0430\u0442\u044c',

      'hud.load': '\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044c',
      'hud.save': '\u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c',
      'hud.cubiks': '\u041a\u0443\u0431\u0438\u043a\u0438',
      'hud.cubiksLabel': '\u041a\u0443\u0431\u0438\u043a\u0438 \u0432 \u0441\u0446\u0435\u043d\u0435',

      'nav.home': '\u0413\u043b\u0430\u0432\u043d\u0430\u044f',
      'nav.shop': '\u041c\u0430\u0433\u0430\u0437\u0438\u043d',
      'nav.about': '\u041e \u043d\u0430\u0441',
      'nav.faq': 'FAQ',
      'nav.gallery': '\u0413\u0430\u043b\u0435\u0440\u0435\u044f',
      'nav.video': '\u0412\u0438\u0434\u0435\u043e',
      'nav.blog': '\u0411\u043b\u043e\u0433',
      'nav.partnership': '\u041f\u0430\u0440\u0442\u043d\u0451\u0440\u0441\u0442\u0432\u043e',
      'nav.contacts': '\u041a\u043e\u043d\u0442\u0430\u043a\u0442\u044b'
    }
  };

  function t(key) {
    var pack = DICT[currentLang] || DICT.en;
    if (pack && Object.prototype.hasOwnProperty.call(pack, key)) {
      return pack[key];
    }
    if (DICT.en && Object.prototype.hasOwnProperty.call(DICT.en, key)) {
      return DICT.en[key];
    }
    return key;
  }

  function apply() {
    // <title>
    var titleEl = doc.querySelector('title[data-i18n-key]');
    if (titleEl) titleEl.textContent = t(titleEl.getAttribute('data-i18n-key'));

    var nodes = doc.querySelectorAll('[data-i18n-key]');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var key = node.getAttribute('data-i18n-key');
      if (!key) continue;

      var value = t(key);
      var attrName = node.getAttribute('data-i18n-attr');

      if (attrName) {
        if (attrName === 'placeholder') {
          node.setAttribute('placeholder', value);
        } else {
          node.setAttribute(attrName, value);
        }
      } else {
        node.textContent = value;
      }
    }
  }

  function setLang(lang) {
    var next = normalizeLang(lang);
    if (next === currentLang) return;
    currentLang = next;
    try {
      doc.documentElement.setAttribute('lang', currentLang);
      doc.documentElement.setAttribute('data-lang', currentLang);
    } catch(e){}
    apply();
  }

  global.CubikI18N = {
    get lang() { return currentLang; },
    t: t,
    apply: apply,
    setLang: setLang
  };

  doc.addEventListener('DOMContentLoaded', apply);
})(window, document);
// === End i18n / language module ====================================
