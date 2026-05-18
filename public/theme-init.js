(function () {
  var t = localStorage.getItem('dab.theme') || 'light';
  document.documentElement.dataset.theme = t;
})();
