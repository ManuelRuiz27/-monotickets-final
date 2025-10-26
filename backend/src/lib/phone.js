export function normalizePhone(input) {
  if (typeof input !== 'string') {
    return '';
  }
  const digits = input.trim();
  if (!digits) {
    return '';
  }
  return digits.replace(/\D+/g, '').replace(/^52(?=1?\d{10}$)/, '52');
}

export function normalizeWhatsappPhone(input) {
  const normalized = normalizePhone(input);
  if (!normalized) {
    return '';
  }
  return normalized.startsWith('0') ? normalized.replace(/^0+/, '') : normalized;
}
