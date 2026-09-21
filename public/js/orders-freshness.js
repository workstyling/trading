(function (root) {
  'use strict';
  function updateOrdersFreshnessStatus(element, response) {
    if (!element) return;
    const usable = response && response.success === true && Array.isArray(response.orders);
    const fresh = usable && response.stale === false;
    let message = '';
    if (!fresh) {
      message = usable
        ? 'Ордера не обновлены. Показан сохранённый список; статусы могут быть устаревшими.'
        : 'Не удалось обновить ордера. Свежие статусы пока недоступны.';
      if (usable && typeof response.updatedAt === 'number' && Number.isFinite(response.updatedAt) && response.updatedAt > 0) {
        message += ' Последнее обновление: ' + new Date(response.updatedAt).toLocaleTimeString('ru-RU') + '.';
      }
    }
    element.textContent = message;
    element.hidden = fresh;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { updateOrdersFreshnessStatus };
  else root.updateOrdersFreshnessStatus = updateOrdersFreshnessStatus;
})(typeof window !== 'undefined' ? window : globalThis);
