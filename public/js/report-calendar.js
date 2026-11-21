// Report days follow the shop's calendar even when the device is in a different zone.
export function reportCalendar(timeZone) {
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  // Find the first instant of the date. A clock change can skip or repeat midnight.
  function startOf(key) {
    const utc = Date.parse(`${key}T00:00:00Z`);
    let low = utc - 86400000;
    let high = utc + 86400000;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (date.format(middle) < key) low = middle;
      else high = middle;
    }
    return new Date(high).toISOString();
  }
  return { dayKey: date.format, range: (first, afterLast) => ({ from: startOf(first), to: startOf(afterLast) }) };
}
