import path from 'path'

export const sanitizeLogArg = (value: unknown): unknown => {
  if (value instanceof Error) return value.message
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null ||
    value === undefined
  ) {
    return value
  }
  return '[redacted]'
}

export const toBoolSetting = (value: unknown, fallback = false): boolean => {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw)
}

export const maskSensitiveValue = (value: string): string => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.length <= 4) return `•••• ${raw}`
  return `•••• ${raw.slice(-4)}`
}

export const toCETDateTime = (value?: Date | string): string | null => {
  const date = value ? new Date(value) : new Date()
  if (Number.isNaN(date.getTime())) return null

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)

  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${lookup.year}-${lookup.month}-${lookup.day} ${lookup.hour}:${lookup.minute}:${lookup.second}`
}

export const roundToTwo = (value: number): number =>
  Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100

export const toNullableNumber = (value: unknown): number | null => {
  if (value === '' || value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export const parseTaxRateFromDbValue = (value: unknown): number => {
  if (value == null) return 0

  const raw = String(value).trim()
  if (!raw) return 0

  const numeric = Number(raw.replace('%', '').trim())
  if (!Number.isFinite(numeric)) return 0

  return numeric > 1 ? numeric / 100 : numeric
}

export const calculateCommissionAmount = (
  baseAmount: number,
  commissionRate: number,
  commissionFixed: number,
): number => {
  return roundToTwo(Number(baseAmount || 0) * Number(commissionRate || 0) + Number(commissionFixed || 0))
}

export const calculateTaxOnItem = (lineAmount: number, taxRate: number): number => {
  return roundToTwo(Number(lineAmount || 0) * Number(taxRate || 0))
}

export const calculateNetEarning = (
  grandTotal: number,
  totalTax: number,
  commissionAmount: number,
): number => {
  return roundToTwo(Number(grandTotal || 0) - Number(totalTax || 0) - Number(commissionAmount || 0))
}

export interface CartPricingItem {
  unit_price: number
  quantity: number
  tax_rate: number
}

export interface ShipmentPricingItem {
  fee_incl_vat: number
}

export interface OrderPricingItem {
  product_type?: string | null
  quantity?: number | string | null
  unit_price?: number | string | null
  total_price?: number | string | null
  tax_amount?: number | string | null
}

const safePricingNumber = (value: unknown): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export const calculateLineTotalInclVat = (item: CartPricingItem): number => {
  return Math.round(
    safePricingNumber(item.unit_price) * safePricingNumber(item.quantity) * (1 + safePricingNumber(item.tax_rate)),
  )
}

export const calculateCartTotals = (
  items: CartPricingItem[],
  shipments: ShipmentPricingItem[] = [],
): {
  subtotalInclVat: number
  shipmentInclVat: number
  totalInclVat: number
} => {
  const subtotalInclVat = items.reduce((sum, item) => sum + calculateLineTotalInclVat(item), 0)
  const shipmentInclVat = shipments.reduce((sum, shipment) => sum + safePricingNumber(shipment.fee_incl_vat), 0)
  return {
    subtotalInclVat,
    shipmentInclVat,
    totalInclVat: subtotalInclVat + shipmentInclVat,
  }
}

export const calculateOrderItemTotalInclVat = (item: OrderPricingItem): number => {
  const qty = safePricingNumber(item.quantity)
  const unitPrice = safePricingNumber(item.unit_price)
  const totalExclVat = safePricingNumber(item.total_price ?? unitPrice * qty)
  const taxAmount = safePricingNumber(item.tax_amount)
  if (String(item.product_type || '').toLowerCase() === 'shipment') {
    return totalExclVat + taxAmount
  }
  const taxRate = totalExclVat > 0 ? taxAmount / totalExclVat : 0
  return calculateLineTotalInclVat({
    unit_price: unitPrice,
    quantity: qty,
    tax_rate: taxRate,
  })
}

export const calculateOrderTotalFromItems = (
  items: OrderPricingItem[] | undefined | null,
  fallbackGrandTotal: number | string = 0,
): number => {
  if (!Array.isArray(items) || items.length === 0) {
    return safePricingNumber(fallbackGrandTotal)
  }
  const productItems: CartPricingItem[] = items
    .filter((item) => String(item.product_type || '').toLowerCase() !== 'shipment')
    .map((item) => {
      const qty = safePricingNumber(item.quantity)
      const unitPrice = safePricingNumber(item.unit_price)
      const totalExclVat = safePricingNumber(item.total_price ?? unitPrice * qty)
      const taxAmount = safePricingNumber(item.tax_amount)
      return {
        unit_price: unitPrice,
        quantity: qty,
        tax_rate: totalExclVat > 0 ? taxAmount / totalExclVat : 0,
      }
    })
  const shipmentItems: ShipmentPricingItem[] = items
    .filter((item) => String(item.product_type || '').toLowerCase() === 'shipment')
    .map((item) => {
      const qty = safePricingNumber(item.quantity)
      const unitPrice = safePricingNumber(item.unit_price)
      const totalExclVat = safePricingNumber(item.total_price ?? unitPrice * qty)
      return {
        fee_incl_vat: totalExclVat + safePricingNumber(item.tax_amount),
      }
    })
  return calculateCartTotals(productItems, shipmentItems).totalInclVat
}

export const getPaymentProviderFromReference = (
  paymentReferenceId?: string | null,
): 'stripe' | 'swish' | 'unknown' => {
  const reference = String(paymentReferenceId || '').trim()
  if (!reference) return 'unknown'
  if (/^[0-9A-F]{32}$/i.test(reference)) return 'swish'
  if (reference.startsWith('pi_')) return 'stripe'
  return 'unknown'
}

export const calculatePaymentProcessorFee = (
  grandTotal: number,
  fixedCost: number,
  percentCost: number,
): number => {
  const safeGrandTotal = Number.isFinite(Number(grandTotal)) ? Number(grandTotal) : 0
  const safeFixed = Number.isFinite(Number(fixedCost)) ? Number(fixedCost) : 0
  const safePercent = Number.isFinite(Number(percentCost)) ? Number(percentCost) : 0
  return roundToTwo(safeFixed + safeGrandTotal * (safePercent / 100))
}

export const generateGroupOrderId = (): string => {
  const random = Math.random().toString(36).substring(2, 10).toUpperCase()
  return `G-${random}`
}

export const generateSellerOrderId = (groupOrderId: string, sellerId: number | string): string => {
  return `${groupOrderId}-S${sellerId}`
}

export const normalizeCountryCode = (value: unknown): string => {
  const raw = String(value || '').trim()
  if (!raw) return 'SE'

  if (/^[A-Za-z]{2}$/.test(raw)) {
    return raw.toUpperCase()
  }

  const normalized = raw.toLowerCase()
  const map: Record<string, string> = {
    sweden: 'SE',
    sverige: 'SE',
    norway: 'NO',
    norge: 'NO',
    denmark: 'DK',
    danmark: 'DK',
    finland: 'FI',
    germany: 'DE',
    deutschland: 'DE',
    netherlands: 'NL',
    holland: 'NL',
    france: 'FR',
    italy: 'IT',
    spain: 'ES',
    poland: 'PL',
    unitedkingdom: 'GB',
    'united kingdom': 'GB',
    uk: 'GB',
  }

  return map[normalized] || 'SE'
}

export const escapeXml = (value: string): string =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

export const escapeHtml = (value: string): string =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

export const sanitizeDisputeInput = (value: unknown, maxLen: number): string => {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .replace(/[`$;\\]/g, '')
    .trim()
    .slice(0, maxLen)
}

export const sanitizeDisputeFileName = (value: unknown): string => {
  return (
    path
      .basename(String(value ?? 'evidence'))
      .replace(/[\u0000-\u001F\u007F<>:"/\\|?*`]/g, '_')
      .trim()
      .slice(0, 200) || 'evidence'
  )
}

export const formatIsoDate = (val: unknown): string => {
  if (!val) return ''
  if (val instanceof Date) {
    const y = val.getFullYear()
    const m = String(val.getMonth() + 1).padStart(2, '0')
    const d = String(val.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  return String(val).slice(0, 10)
}

export const resolveSmtpSecure = (value: string, port: number): boolean => {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false
  return port === 465
}

export const buildLegalBasisForDispute = (orderType: 'Product' | 'Service', reason: string): string => {
  const lower = String(reason || '').toLowerCase()
  if (orderType === 'Service') {
    if (lower.includes('cancel') || lower.includes('refund')) {
      return 'Distance Contracts Act (2005:59) / Consumer Services Act (1985:716) — assess cancellation & contract terms'
    }
    return 'Consumer Services Act (1985:716) — assess service performance, duration, and agreed terms'
  }
  if (lower.includes('damage') || lower.includes('defect')) {
    return 'Consumer Sales Act (2022:260) — possible defect in goods / transit damage'
  }
  if (lower.includes('wrong') || lower.includes('described')) {
    return 'Consumer Sales Act (2022:260) — possible non-conformity with contract'
  }
  return 'Consumer Sales Act (2022:260) / Distance Contracts Act (2005:59) — confirm applicable terms and dates'
}

export const formatDisputeDate = (val: unknown): string => {
  if (!val) return ''
  const d = new Date(val as string | number | Date)
  if (Number.isNaN(d.getTime())) return String(val)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export const formatDisputeDateTime = (val: unknown): string => {
  if (!val) return ''
  const d = new Date(val as string | number | Date)
  if (Number.isNaN(d.getTime())) return String(val)
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export const formatDisputePayload = (row: any, messages: any[], evidence: any[]) => {
  let selectedItems: any[] = []
  try {
    selectedItems = row.selected_items_json ? JSON.parse(row.selected_items_json) : []
  } catch {
    selectedItems = []
  }
  return {
    numericId: Number(row.id),
    id: String(row.case_number),
    buyerToken: String(row.buyer_token),
    saleId: Number(row.sale_id),
    orderRef: String(row.order_id),
    groupOrderId: row.group_order_id ? String(row.group_order_id) : null,
    type: (row.order_type === 'Service' ? 'Service' : 'Product') as 'Product' | 'Service',
    reason: String(row.reason || ''),
    buyer: String(row.buyer_name || ''),
    buyerEmail: String(row.buyer_email || ''),
    seller: String(row.seller_name || ''),
    sellerId: String(row.seller_id),
    item: String(row.item_summary || ''),
    selectedItems,
    amount: Number(row.amount || 0),
    opened: formatDisputeDate(row.created_at),
    updated: formatDisputeDateTime(row.updated_at),
    status: row.status,
    paymentStatus: row.payment_status,
    requested: String(row.requested_solution || ''),
    description: String(row.description || ''),
    legalBasis: String(row.legal_basis || ''),
    purchaseDate: formatDisputeDate(row.purchase_date),
    defectDiscovered: row.defect_discovered_date ? formatDisputeDate(row.defect_discovered_date) : undefined,
    serviceDate: row.service_date ? formatDisputeDate(row.service_date) : undefined,
    serviceBookingId: row.service_booking_id != null ? Number(row.service_booking_id) : undefined,
    requestedBookingDate: row.requested_booking_date ? formatIsoDate(row.requested_booking_date) : undefined,
    requestedStartTime: row.requested_start_time ? String(row.requested_start_time).slice(0, 5) : undefined,
    requestedEndTime: row.requested_end_time ? String(row.requested_end_time).slice(0, 5) : undefined,
    complaintDate: formatDisputeDate(row.complaint_date || row.created_at),
    responseDeadline: row.response_deadline ? new Date(row.response_deadline).toISOString().slice(0, 10) : '',
    responseDeadlineLabel: row.response_deadline ? formatDisputeDate(row.response_deadline) : '',
    resolutionType: row.resolution_type || undefined,
    resolutionResponsible: row.resolution_responsible || undefined,
    refundAmount: row.refund_amount != null ? Number(row.refund_amount) : undefined,
    adminNote: row.admin_note || undefined,
    resolution: row.resolution_summary || undefined,
    messages: messages.map((m) => ({
      id: Number(m.id),
      author: String(m.author_name),
      role: String(m.author_role),
      date: formatDisputeDateTime(m.created_at),
      text: String(m.message_text),
    })),
    evidence: evidence.map((e) => ({
      id: Number(e.id),
      name: String(e.file_name),
      url: String(e.file_url),
      uploadedByRole: String(e.uploaded_by_role),
      uploadedByName: String(e.uploaded_by_name),
      createdAt: formatDisputeDateTime(e.created_at),
    })),
  }
}

export const normalizeServiceJsonField = (raw: unknown): any[] => {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}
