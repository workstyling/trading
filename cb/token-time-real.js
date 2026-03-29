function updatePercentages(coin, data) {
  const row = document.querySelector(`tr[data-coin="${coin}"]`);
  if (row) {
    // Обновляем объем
    const volumeCell = row.querySelector('.vol');
    if (volumeCell && data.volume) {
      volumeCell.textContent = data.volume;
      volumeCell.classList.add('coin-update');
      setTimeout(() => {
        volumeCell.classList.remove('coin-update');
      }, 2000);
    }

    Object.entries(data.changes).forEach(([interval, value]) => {
      const cell = row.querySelector(`td[data-interval="${interval}"]`);
      if (cell) {
        const percentage = parseFloat(value).toFixed(2);
        const color = percentage >= 0 ? 'text-green' : 'text-red';
        
        // Сохраняем предыдущее значение для расчета изменения
        const prevValue = cell.getAttribute('data-prev-value') || percentage;
        const change = (percentage - parseFloat(prevValue)).toFixed(2);
        const changeColor = change >= 0 ? 'text-green' : 'text-red';
        
        let cellContent = `<span class="${color}">${percentage}%</span>`;
        
        // Добавляем изменение в скобках
        if (prevValue !== percentage) {
          cellContent += ` <span class="${changeColor}">(${change}%)</span>`;
        }
        
        // Сохраняем текущее значение как предыдущее
        cell.setAttribute('data-prev-value', percentage);

        cell.innerHTML = cellContent;
        cell.classList.add('coin-update');
        setTimeout(() => {
          cell.classList.remove('coin-update');
        }, 2000);
      }
    });
  }
} 