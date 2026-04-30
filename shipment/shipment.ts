import util from 'node:util'

type LabelFormat = 'PDF' | 'PNG' | 'ZPL'

export interface ShipmentAddressInput {
	name?: string
	companyName?: string
	street: string
	postalCode: string
	city: string
	countryCode: string
	contactName?: string
	emailAddress?: string
	phoneNo?: string
	smsNo?: string
}

export interface ShipmentDimensionsInput {
	lengthCm: number
	widthCm: number
	heightCm: number
}

export interface GenerateShipmentLabelInput {
	address: ShipmentAddressInput
	dimensions: ShipmentDimensionsInput
	weightKg: number
	labelFormat?: LabelFormat
	paperSize?: 'A4' | 'A5' | 'LABEL'
	labelType?: 'standard' | 'small' | 'ste'
	referenceNo?: string
	endpointPath?: string
	serviceCode?: string
	additionalServiceCodes?: string[]
	senderAddress?: ShipmentAddressInput
	externalPayload?: Record<string, unknown>
}

export interface ShipmentLabelOutput {
	bookingId: string | null
	trackingNumber: string | null
	format: 'pdf' | 'image' | 'zpl' | 'unknown'
	mimeType: string
	fileName: string
	base64: string | null
	dataUrl: string | null
	contentBuffer: Buffer | null
	labelUrl: string | null
	raw: unknown
}

export interface TrackShipmentOutput {
	trackingNumber: string
	status: string | null
	statusDescription: string | null
	estimatedDelivery: string | null
	events: Array<{
		date: string | null
		status: string | null
		location: string | null
		description: string | null
		eventCode?: string | null
	}>
	raw: unknown
	// PostNord enriched fields
	shipmentId?: string | null
	service?: { code?: string | null; name?: string | null } | null
	statusText?: { header?: string | null; body?: string | null } | null
	deliveryDate?: string | null
	weight?: { value?: string | null; unit?: string | null } | null
	consignor?: { name?: string | null; country?: string | null } | null
	consignee?: { country?: string | null; postCode?: string | null } | null
}

export interface EstimateShipmentCostInput {
	address: ShipmentAddressInput
	dimensions: ShipmentDimensionsInput
	weightKg: number
	toEmail?: string
	toMobilePhone?: string
	serviceCode?: string
	additionalServiceCodes?: string[]
	senderAddress?: ShipmentAddressInput
	endpointPath?: string
	externalPayload?: Record<string, unknown>
	// Portal pricing fields
	shipTo?: 'HOME' | 'SERVICEPOINT'
	pickup?: 'NO_PICKUP' | 'BOOK_PICKUP'
	packageType?: string
	recipientType?: 'PRIVATE' | 'BUSINESS'
	market?: string
	language?: string
	validSalesOrganizations?: string[]
	servicePointAddressLine1?: string
	servicePointZipCode?: string | null
	servicePointArea?: string
	productType?: string
	additionalInformation?: boolean
}

export interface EstimateShipmentCostOutput {
	amount: number | null
	currency: string | null
	deliveryTime: string | null
	breakdown: Array<{
		label: string
		amount: number
		currency: string | null
	}>
	raw: unknown
}

export class ShipmentProviderError extends Error {
	statusCode?: number
	details?: unknown

	constructor(message: string, statusCode?: number, details?: unknown) {
		super(message)
		this.name = 'ShipmentProviderError'
		this.statusCode = statusCode
		this.details = details
	}
}

const getTrimmedEnv = (key: string): string | undefined => {
	const raw = process.env[key]
	if (typeof raw !== 'string') return undefined
	const trimmed = raw.trim()
	return trimmed.length > 0 ? trimmed : undefined
}

const POSTNORD_SANDBOX_HOST = (() => {
	const value = getTrimmedEnv('POSTNORD_SANDBOX_HOST')
	return value !== undefined ? value : 'https://atapi2.postnord.com'
})()

const POSTNORD_PRODUCTION_HOST = (() => {
	const value = getTrimmedEnv('POSTNORD_PRODUCTION_HOST')
	return value !== undefined ? value : 'https://atapi2.postnord.com'
})()

const DEFAULT_TRACK_PATH = (() => {
	const value = getTrimmedEnv('POSTNORD_DEFAULT_TRACK_PATH')
	return value !== undefined ? value : '/rest/shipment/v5/trackandtrace/findByIdentifier.json'
})()

const DEFAULT_BOOK_EDI_PATH = (() => {
	const value = getTrimmedEnv('POSTNORD_DEFAULT_BOOK_EDI_PATH')
	return value !== undefined ? value : '/rest/shipment/v3/edi'
})()

const DEFAULT_LABEL_PDF_PATH = (() => {
	const value = getTrimmedEnv('POSTNORD_DEFAULT_LABEL_PDF_PATH')
	return value !== undefined ? value : '/rest/shipment/v3/edi/labels/pdf'
})()

const DEFAULT_LABEL_ZPL_PATH = (() => {
	const value = getTrimmedEnv('POSTNORD_DEFAULT_LABEL_ZPL_PATH')
	return value !== undefined ? value : '/rest/shipment/v3/edi/labels/zpl'
})()

const DEFAULT_TRANSIT_TIME_PATH = (() => {
	const value = getTrimmedEnv('POSTNORD_DEFAULT_TRANSIT_TIME_PATH')
	return value !== undefined ? value : '/rest/transport/v1/transittime/calculateRoute'
})()

const DEFAULT_COST_PORTAL_PATH = (() => {
	const value = getTrimmedEnv('POSTNORD_DEFAULT_COST_PORTAL_PATH')
	return value !== undefined ? value : '/api/pricing/agreementProduct'
})()

const POSTNORD_PORTAL_HOST = (() => {
	const value = getTrimmedEnv('POSTNORD_PORTAL_HOST')
	return value !== undefined ? value : 'https://portal.postnord.com'
})()

const DEFAULT_FALLBACK_CURRENCY = (() => {
	const value = getTrimmedEnv('DEFAULT_FALLBACK_CURRENCY')
	return value !== undefined ? value : 'SEK'
})()

let portalPricingDisabledForSession = false
let transitTimeCooldownUntil = 0

const getEnv = (key: string): string => String(process.env[key] || '').trim()

const isTruthyEnv = (key: string, defaultValue = false): boolean => {
	const value = getEnv(key)
	if (!value) return defaultValue
	return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

const isPostNordDebugLogsEnabled = (): boolean => isTruthyEnv('POSTNORD_DEBUG_LOGS', process.env.NODE_ENV !== 'production')

const shouldLogPostNordTraffic = (path: string): boolean => {
	const normalizedPath = String(path || '').toLowerCase()
	return normalizedPath.includes('/trackandtrace/') || normalizedPath.includes('/edi')
}

const formatForLog = (value: unknown): string => util.inspect(value, {
	depth: null,
	colors: false,
	maxArrayLength: null,
	maxStringLength: null,
	compact: false,
	breakLength: 120,
})

const getPostNordHost = (): string => {
	const explicitHost = getEnv('POSTNORD_HOST')
	if (explicitHost) return explicitHost.replace(/\/+$/, '')

	const mode = getEnv('POSTNORD_ENV').toLowerCase()
	if (mode === 'prod' || mode === 'production') return POSTNORD_PRODUCTION_HOST
	return POSTNORD_SANDBOX_HOST
}

const getApiKey = (): string => {
	const apiKey = getEnv('POSTNORD_API_KEY')
	if (!apiKey) {
		throw new ShipmentProviderError('POSTNORD_API_KEY is not set.')
	}
	return apiKey
}

const buildUrl = (path: string, query?: Record<string, string | number | undefined>): string => {
	const normalizedPath = path.startsWith('/') ? path : `/${path}`
	const url = new URL(`${getPostNordHost()}${normalizedPath}`)

	if (query) {
		for (const [key, value] of Object.entries(query)) {
			if (value === undefined || value === null || value === '') continue
			url.searchParams.set(key, String(value))
		}
	}

	return url.toString()
}

const isObject = (value: unknown): value is Record<string, unknown> => {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const toFiniteNumber = (value: unknown): number => {
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

const roundTo2 = (value: number): number => Math.round(value * 100) / 100

const getFiniteEnvNumber = (key: string, fallback: number): number => {
	const value = getEnv(key)
	if (!value) return fallback
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : fallback
}

const requirePositiveNumber = (name: string, value: number) => {
	if (!Number.isFinite(value) || value <= 0) {
		throw new ShipmentProviderError(`${name} must be a positive number.`)
	}
}

const requireAddress = (address: ShipmentAddressInput, fieldName = 'address') => {
	if (!String(address.street || '').trim()) {
		throw new ShipmentProviderError(`${fieldName}.street is required.`)
	}
	if (!String(address.postalCode || '').trim()) {
		throw new ShipmentProviderError(`${fieldName}.postalCode is required.`)
	}
	if (!String(address.city || '').trim()) {
		throw new ShipmentProviderError(`${fieldName}.city is required.`)
	}
	const countryCode = String(address.countryCode || '').trim().toUpperCase()
	if (!countryCode || countryCode.length !== 2) {
		console.error(`[Shipment] Country code validation failed:`, {
			fieldName,
			rawValue: address.countryCode,
			normalized: countryCode,
			length: countryCode.length,
			address,
		})
		throw new ShipmentProviderError(`${fieldName}.countryCode must be a valid 2-character ISO country code (e.g., 'SE', 'NO'). Received: "${countryCode}" (length: ${countryCode.length})`)
	}
}

const postNordRequest = async <T>(options: {
	method: 'GET' | 'POST'
	path: string
	query?: Record<string, string | number | undefined>
	body?: unknown
}): Promise<T> => {
	const apiKey = getApiKey()
	const logEnabled = isPostNordDebugLogsEnabled() && shouldLogPostNordTraffic(options.path)
	const maskedQuery = {
		...(options.query || {}),
		apikey: apiKey ? '***' : '',
	}
	const url = buildUrl(options.path, {
		...options.query,
		apikey: apiKey,
	})

	if (logEnabled) {
		console.log(`[PostNord] request\n${formatForLog({
			method: options.method,
			path: options.path,
			query: maskedQuery,
			body: options.body ?? null,
		})}`)
	}

	const response = await fetch(url, {
		method: options.method,
		headers: {
			'Content-Type': 'application/json',
		},
		body: options.body ? JSON.stringify(options.body) : undefined,
	})

	const responseText = await response.text()
	const parsedBody: unknown = (() => {
		if (!responseText) return null
		try {
			return JSON.parse(responseText)
		} catch {
			return responseText
		}
	})()

	if (logEnabled) {
		console.log(`[PostNord] response\n${formatForLog({
			method: options.method,
			path: options.path,
			status: response.status,
			ok: response.ok,
			data: parsedBody,
		})}`)
	}

	if (!response.ok) {
		// Log composite faults if present (EDI validation errors)
		if (isObject(parsedBody) && isObject(parsedBody.compositeFault) && Array.isArray(parsedBody.compositeFault.faults)) {
			console.error('[PostNord] EDI validation faults:', parsedBody.compositeFault.faults)
		}
		throw new ShipmentProviderError(
			`PostNord request failed with status ${response.status}.`,
			response.status,
			parsedBody,
		)
	}

	return parsedBody as T
}

const makeMessageId = (): string => {
	const now = Date.now().toString(36).toUpperCase()
	const rand = Math.random().toString(36).slice(2, 7).toUpperCase()
	return `MSG-${now}-${rand}`.slice(0, 30)
}

const buildParty = (address: ShipmentAddressInput) => {
	const countryCode = String(address.countryCode || '').trim().toUpperCase().slice(0, 2)
	return {
		party: {
			nameIdentification: {
				name: address.name || address.contactName || 'Recipient',
				companyName: address.companyName || undefined,
			},
			address: {
				streets: [address.street],
				postalCode: address.postalCode,
				city: address.city,
				countryCode,
			},
			contact: {
				contactName: address.contactName || address.name || 'Contact',
				emailAddress: address.emailAddress || undefined,
				phoneNo: address.phoneNo || undefined,
				smsNo: address.smsNo || undefined,
			},
		},
	}
}

const getDefaultSenderAddress = (): ShipmentAddressInput => {
	return {
		name: getEnv('POSTNORD_SENDER_NAME') || 'Sender',
		companyName: getEnv('POSTNORD_SENDER_COMPANY') || undefined,
		street: getEnv('POSTNORD_SENDER_STREET') || '',
		postalCode: getEnv('POSTNORD_SENDER_POSTAL_CODE') || '',
		city: getEnv('POSTNORD_SENDER_CITY') || '',
		countryCode: (getEnv('POSTNORD_SENDER_COUNTRY_CODE') || 'SE').toUpperCase(),
		contactName: getEnv('POSTNORD_SENDER_CONTACT') || undefined,
		emailAddress: getEnv('POSTNORD_SENDER_EMAIL') || undefined,
		phoneNo: getEnv('POSTNORD_SENDER_PHONE') || undefined,
		smsNo: getEnv('POSTNORD_SENDER_SMS') || undefined,
	}
}

const buildLabelPayload = (input: GenerateShipmentLabelInput): Record<string, unknown> => {
	const senderAddress = input.senderAddress || getDefaultSenderAddress()
	requireAddress(input.address)
	requireAddress(senderAddress, 'senderAddress')

	const dimensions = {
		lengthCm: toFiniteNumber(input.dimensions.lengthCm),
		widthCm: toFiniteNumber(input.dimensions.widthCm),
		heightCm: toFiniteNumber(input.dimensions.heightCm),
	}
	requirePositiveNumber('dimensions.lengthCm', dimensions.lengthCm)
	requirePositiveNumber('dimensions.widthCm', dimensions.widthCm)
	requirePositiveNumber('dimensions.heightCm', dimensions.heightCm)

	const weightKg = toFiniteNumber(input.weightKg)
	requirePositiveNumber('weightKg', weightKg)

	const customerNumber = getEnv('POSTNORD_CUSTOMER_NUMBER')
	const issuerCode = getEnv('POSTNORD_ISSUER_CODE') || 'Z12'
	const applicationId = getEnv('POSTNORD_APPLICATION_ID') || '0000'

	if (!customerNumber) {
		throw new ShipmentProviderError('POSTNORD_CUSTOMER_NUMBER is not set.')
	}

	const referenceNo = String(input.referenceNo || makeMessageId())
	const serviceCode = String(input.serviceCode || '18')
	const additionalServiceCode = Array.isArray(input.additionalServiceCodes)
		? input.additionalServiceCodes.filter((value) => String(value || '').trim())
		: []

	return {
		messageDate: new Date().toISOString(),
		messageFunction: 'Instruction',
		messageId: makeMessageId(),
		updateIndicator: 'Original',
		application: {
			applicationId,
			name: 'SellingPlatform',
			version: '1.0',
		},
		shipment: [
			{
				shipmentIdentification: {
					shipmentId: '0',
				},
				service: {
					basicServiceCode: serviceCode,
					additionalServiceCode,
				},
				references: [
					{
						referenceNo,
						referenceType: 'CU',
					},
				],
				parties: {
					consignor: {
						issuerCode,
						partyIdentification: {
							partyId: customerNumber,
							partyIdType: '160',
						},
						...buildParty(senderAddress),
					},
					consignee: {
						...buildParty(input.address),
					},
				},
				goodsItem: [
					{
						packageTypeCode: 'PC',
						items: [
							{
								itemIdentification: {
									itemId: '0',
								},
								dimensions: {
									height: { value: dimensions.heightCm, unit: 'CMT' },
									width: { value: dimensions.widthCm, unit: 'CMT' },
									length: { value: dimensions.lengthCm, unit: 'CMT' },
								},
								grossWeight: {
									value: weightKg,
									unit: 'KGM',
								},
							},
						],
					},
				],
				labelInformation: {
					format: String(input.labelFormat || 'PDF').toUpperCase(),
				},
			},
		],
	}
}

const buildEdiShipmentPayload = (input: GenerateShipmentLabelInput): Record<string, unknown> => {
	const senderAddress = input.senderAddress || getDefaultSenderAddress()
	
	console.log('[Shipment EDI] Building EDI payload with addresses:', {
		recipientAddress: {
			street: input.address?.street,
			postalCode: input.address?.postalCode,
			city: input.address?.city,
			countryCode: input.address?.countryCode,
			companyName: input.address?.companyName,
		},
		senderAddress: {
			street: senderAddress?.street,
			postalCode: senderAddress?.postalCode,
			city: senderAddress?.city,
			countryCode: senderAddress?.countryCode,
			companyName: senderAddress?.companyName,
		},
	})
	
	requireAddress(input.address)
	requireAddress(senderAddress, 'senderAddress')

	const dimensions = {
		lengthCm: toFiniteNumber(input.dimensions.lengthCm),
		widthCm: toFiniteNumber(input.dimensions.widthCm),
		heightCm: toFiniteNumber(input.dimensions.heightCm),
	}
	requirePositiveNumber('dimensions.lengthCm', dimensions.lengthCm)
	requirePositiveNumber('dimensions.widthCm', dimensions.widthCm)
	requirePositiveNumber('dimensions.heightCm', dimensions.heightCm)

	const weightKg = toFiniteNumber(input.weightKg)
	requirePositiveNumber('weightKg', weightKg)

	const customerNumber = getEnv('POSTNORD_CUSTOMER_NUMBER')
	const issuerCode = getEnv('POSTNORD_ISSUER_CODE') || 'Z12'
	const applicationId = getEnv('POSTNORD_APPLICATION_ID') || '0000'

	if (!customerNumber) {
		throw new ShipmentProviderError('POSTNORD_CUSTOMER_NUMBER is not set.')
	}

	const referenceNo = String(input.referenceNo || makeMessageId())
	const serviceCode = String(input.serviceCode || '18')
	const additionalServiceCode = Array.isArray(input.additionalServiceCodes)
		? input.additionalServiceCodes.filter((value) => String(value || '').trim())
		: []

	// Build service object - EDI API does not support additionalServiceCode
	const serviceObj: Record<string, unknown> = {
		basicServiceCode: serviceCode,
	}

	const now = new Date().toISOString()

	// EDI format: requires messageDate and updateIndicator at root level
	return {
		messageDate: now,
		messageFunction: 'Instruction',
		messageId: makeMessageId(),
		application: {
			applicationId: Number.isFinite(Number(applicationId)) ? Number(applicationId) : 0,
			name: 'SellingPlatform',
			version: '1.0',
		},
		updateIndicator: 'Original',
		shipment: [
			{
				shipmentIdentification: {
					shipmentId: '0',
				},
				dateAndTimes: {
					loadingDate: now,
				},
				service: serviceObj,
				freeText: [],
				numberOfPackages: {
					value: 1,
				},
				totalGrossWeight: {
					value: weightKg,
					unit: 'KGM',
				},
				references: [
					{
						referenceNo,
						referenceType: 'CU',
					},
				],
				parties: {
					consignor: {
						issuerCode,
						partyIdentification: {
							partyId: customerNumber,
							partyIdType: '160',
						},
						...buildParty(senderAddress),
					},
					consignee: {
						...buildParty(input.address),
					},
				},
				goodsItem: [
					{
						packageTypeCode: 'PC',
						items: [
							{
								itemIdentification: {
									itemId: '0',
								},
								dimensions: {
									height: { value: dimensions.heightCm, unit: 'CMT' },
									width: { value: dimensions.widthCm, unit: 'CMT' },
									length: { value: dimensions.lengthCm, unit: 'CMT' },
								},
								grossWeight: {
									value: weightKg,
									unit: 'KGM',
								},
							},
						],
					},
				],
			},
		],
	}
}

const buildCostPayload = (input: EstimateShipmentCostInput): Record<string, unknown> => {
	const senderAddress = input.senderAddress || getDefaultSenderAddress()
	requireAddress(input.address)
	requireAddress(senderAddress, 'senderAddress')

	const dimensions = {
		lengthCm: toFiniteNumber(input.dimensions.lengthCm),
		widthCm: toFiniteNumber(input.dimensions.widthCm),
		heightCm: toFiniteNumber(input.dimensions.heightCm),
	}
	requirePositiveNumber('dimensions.lengthCm', dimensions.lengthCm)
	requirePositiveNumber('dimensions.widthCm', dimensions.widthCm)
	requirePositiveNumber('dimensions.heightCm', dimensions.heightCm)

	const weightKg = toFiniteNumber(input.weightKg)
	requirePositiveNumber('weightKg', weightKg)

	const serviceCode = String(input.serviceCode || '18')
	const additionalServiceCode = Array.isArray(input.additionalServiceCodes)
		? input.additionalServiceCodes.filter((value) => String(value || '').trim())
		: []

	return {
		requestDate: new Date().toISOString(),
		service: {
			basicServiceCode: serviceCode,
			additionalServiceCode,
		},
		consignor: {
			postalCode: senderAddress.postalCode,
			city: senderAddress.city,
			countryCode: String(senderAddress.countryCode || '').trim().toUpperCase().slice(0, 2),
		},
		consignee: {
			postalCode: input.address.postalCode,
			city: input.address.city,
			countryCode: String(input.address.countryCode || '').trim().toUpperCase().slice(0, 2),
		},
		goodsItem: [
			{
				packageTypeCode: 'PC',
				items: [
					{
						dimensions: {
							height: { value: dimensions.heightCm, unit: 'CMT' },
							width: { value: dimensions.widthCm, unit: 'CMT' },
							length: { value: dimensions.lengthCm, unit: 'CMT' },
						},
						grossWeight: {
							value: weightKg,
							unit: 'KGM',
						},
					},
				],
			},
		],
	}
}

const portalRequest = async <T>(options: {
	method: 'GET' | 'POST'
	path: string
	query?: Record<string, string | number | undefined>
	body?: unknown
}): Promise<T> => {
	const normalizedPath = options.path.startsWith('/') ? options.path : `/${options.path}`
	const url = new URL(`${POSTNORD_PORTAL_HOST}${normalizedPath}`)
	const logEnabled = isPostNordDebugLogsEnabled()

	if (options.query) {
		for (const [key, value] of Object.entries(options.query)) {
			if (value === undefined || value === null || value === '') continue
			url.searchParams.set(key, String(value))
		}
	}

	if (logEnabled) {
		console.log(`[PostNord Portal] request\n${formatForLog({
			method: options.method,
			path: options.path,
			url: url.toString(),
			query: options.query || null,
			body: options.body ?? null,
		})}`)
	}

	const response = await fetch(url.toString(), {
		method: options.method,
		headers: { 'Content-Type': 'application/json' },
		body: options.body ? JSON.stringify(options.body) : undefined,
	})

	const responseText = await response.text()
	const parsedBody: unknown = (() => {
		if (!responseText) return null
		try { return JSON.parse(responseText) } catch { return responseText }
	})()

	if (logEnabled) {
		console.log(`[PostNord Portal] response\n${formatForLog({
			method: options.method,
			path: options.path,
			url: url.toString(),
			status: response.status,
			ok: response.ok,
			data: parsedBody,
		})}`)
	}

	if (!response.ok) {
		throw new ShipmentProviderError(
			`PostNord Portal request failed with status ${response.status}.`,
			response.status,
			parsedBody,
		)
	}

	return parsedBody as T
}

const buildPortalCostPayload = (input: EstimateShipmentCostInput): Record<string, unknown> => {
	const senderAddress = input.senderAddress || getDefaultSenderAddress()
	requireAddress(input.address)
	requireAddress(senderAddress, 'senderAddress')

	const weightKg = toFiniteNumber(input.weightKg)
	requirePositiveNumber('weightKg', weightKg)

	const customerNumber = getEnv('POSTNORD_CUSTOMER_NUMBER')
	if (!customerNumber) {
		throw new ShipmentProviderError('POSTNORD_CUSTOMER_NUMBER is not set.')
	}

	const rawSalesOrgs = getEnv('POSTNORD_SALES_ORGS')
	const validSalesOrganizations =
		input.validSalesOrganizations ??
		(rawSalesOrgs ? rawSalesOrgs.split(',').map((s) => s.trim()) : ['FO91', 'FO92'])

	const shipTo = (input.shipTo || 'HOME') as 'HOME' | 'SERVICEPOINT'
	const pickup = (input.pickup || 'NO_PICKUP') as 'NO_PICKUP' | 'BOOK_PICKUP'
	const packageType = input.packageType || '3DAY'
	const market = input.market || getEnv('POSTNORD_MARKET') || 'SE'
	const language = input.language || getEnv('POSTNORD_LANGUAGE') || 'en'
	const recipientType = (input.recipientType || 'PRIVATE') as 'PRIVATE' | 'BUSINESS'
	const productType = input.productType || 'PARCEL'
	const additionalInformation = typeof input.additionalInformation === 'boolean' ? input.additionalInformation : true
	const toEmail = String(input.toEmail || input.address.emailAddress || '').trim() || undefined
	const toMobilePhone = String(
		input.toMobilePhone
		|| input.address.smsNo
		|| input.address.phoneNo
		|| '',
	).trim() || undefined

	return {
		section: 'SHIPPING_LABEL',
		language,
		market,
		customerNumber,
		validSalesOrganizations,
		fromCountry: String(senderAddress.countryCode || '').trim().toUpperCase().slice(0, 2),
		fromMobilePhone: senderAddress.smsNo || senderAddress.phoneNo || undefined,
		fromEmail: senderAddress.emailAddress || undefined,
		fromZipCode: senderAddress.postalCode,
		toCountry: String(input.address.countryCode || '').trim().toUpperCase().slice(0, 2),
		toZipCode: input.address.postalCode,
		recipientType,
		servicePointAddressLine1: input.servicePointAddressLine1 || undefined,
		toEmail,
		toMobilePhone,
		quantity: 1,
		shipmentType: 'PARCEL',
		servicePointZipCode: input.servicePointZipCode ?? null,
		servicePointArea: input.servicePointArea || undefined,
		productType,
		selectedAddons: [],
		addonValues: {},
		shipTo,
		pickup,
		packageType,
		selectedWeight: Math.round(weightKg * 1000),
		selectedWeightUnit: 'g',
		additionalInformation,
	}
}

const collectStringValues = (node: unknown, currentPath = '$'): Array<{ path: string; value: string }> => {
	if (node == null) return []

	if (typeof node === 'string') {
		return [{ path: currentPath, value: node }]
	}

	if (Array.isArray(node)) {
		return node.flatMap((value, index) => collectStringValues(value, `${currentPath}[${index}]`))
	}

	if (isObject(node)) {
		return Object.entries(node).flatMap(([key, value]) => collectStringValues(value, `${currentPath}.${key}`))
	}

	return []
}

const tryDecodeBase64 = (text: string): Buffer | null => {
	const normalized = text.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '')
	if (!/^[A-Za-z0-9+/=]+$/.test(normalized) || normalized.length < 80) {
		return null
	}

	try {
		const buffer = Buffer.from(normalized, 'base64')
		return buffer.length > 0 ? buffer : null
	} catch {
		return null
	}
}

const detectMimeType = (buffer: Buffer): { mimeType: string; format: 'pdf' | 'image' | 'zpl' | 'unknown' } => {
	if (buffer.length >= 4 && buffer.slice(0, 4).toString('ascii') === '%PDF') {
		return { mimeType: 'application/pdf', format: 'pdf' }
	}

	if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return { mimeType: 'image/png', format: 'image' }
	}

	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
		return { mimeType: 'image/jpeg', format: 'image' }
	}

	const text = buffer.toString('utf8', 0, Math.min(buffer.length, 300)).toUpperCase()
	if (text.includes('^XA') || text.includes('^XZ')) {
		return { mimeType: 'text/plain', format: 'zpl' }
	}

	return { mimeType: 'application/octet-stream', format: 'unknown' }
}

const normalizeLabelFileName = (format: ShipmentLabelOutput['format']): string => {
	if (format === 'pdf') return 'shipment-label.pdf'
	if (format === 'image') return 'shipment-label.png'
	if (format === 'zpl') return 'shipment-label.zpl'
	return 'shipment-label.bin'
}

const extractBookingId = (raw: unknown): string | null => {
	if (isObject(raw) && typeof raw.bookingId === 'string' && raw.bookingId.trim()) {
		return raw.bookingId.trim()
	}

	const strings = collectStringValues(raw)
	const booking = strings.find((entry) => /bookingid$/i.test(entry.path) && entry.value.trim())
	return booking?.value?.trim() || null
}

const extractTrackingNumber = (raw: unknown): string | null => {
	if (isObject(raw)) {
		const direct = raw.trackingNumber
		if (typeof direct === 'string' && direct.trim()) return direct.trim()
	}

	const strings = collectStringValues(raw)
	const candidates = strings
		.filter((entry) => {
			const p = entry.path.toLowerCase()
			return p.includes('tracking') || p.endsWith('.value') || p.includes('itemid') || p.includes('shipmentid')
		})
		.map((entry) => entry.value.trim())
		.filter((value) => value.length >= 6)

	return candidates[0] || null
}

const maybeAbsoluteUrl = (value: string): string | null => {
	const trimmed = value.trim()
	if (!trimmed) return null
	if (/^https?:\/\//i.test(trimmed)) return trimmed
	if (trimmed.startsWith('/')) return `${getPostNordHost()}${trimmed}`
	return null
}

const fetchLabelFromUrl = async (url: string): Promise<{ buffer: Buffer; mimeType: string; format: ShipmentLabelOutput['format'] }> => {
	const response = await fetch(url)
	if (!response.ok) {
		throw new ShipmentProviderError(`Failed to download label from URL with status ${response.status}.`, response.status)
	}

	const bytes = Buffer.from(await response.arrayBuffer())
	const detected = detectMimeType(bytes)
	const contentType = response.headers.get('content-type') || detected.mimeType
	const format: ShipmentLabelOutput['format'] = contentType.includes('pdf')
		? 'pdf'
		: contentType.startsWith('image/')
			? 'image'
			: detected.format

	return {
		buffer: bytes,
		mimeType: contentType,
		format,
	}
}

const parseLabelResponse = async (raw: unknown): Promise<ShipmentLabelOutput> => {
	const strings = collectStringValues(raw)

	const directDataUrl = strings.find((entry) => /^data:[^;]+;base64,/i.test(entry.value.trim()))?.value || null
	const directDataUrlBuffer = directDataUrl ? tryDecodeBase64(directDataUrl) : null

	const base64Candidate = strings
		.filter((entry) => /label|pdf|png|zpl|base64|document|binary|file/i.test(entry.path))
		.map((entry) => tryDecodeBase64(entry.value))
		.find((buffer): buffer is Buffer => Boolean(buffer)) || null

	const urlCandidate = strings
		.map((entry) => maybeAbsoluteUrl(entry.value))
		.find((url): url is string => Boolean(url)) || null

	const bookingId = extractBookingId(raw)
	const trackingNumber = extractTrackingNumber(raw)

	let contentBuffer: Buffer | null = directDataUrlBuffer || base64Candidate
	let mimeType = 'application/octet-stream'
	let format: ShipmentLabelOutput['format'] = 'unknown'
	let labelUrl: string | null = null

	if (contentBuffer) {
		const detected = detectMimeType(contentBuffer)
		mimeType = detected.mimeType
		format = detected.format
	} else if (urlCandidate) {
		const fetched = await fetchLabelFromUrl(urlCandidate)
		contentBuffer = fetched.buffer
		mimeType = fetched.mimeType
		format = fetched.format
		labelUrl = urlCandidate
	}

	const base64 = contentBuffer ? contentBuffer.toString('base64') : null
	const dataUrl = base64 ? `data:${mimeType};base64,${base64}` : null

	return {
		bookingId,
		trackingNumber,
		format,
		mimeType,
		fileName: normalizeLabelFileName(format),
		base64,
		dataUrl,
		contentBuffer,
		labelUrl,
		raw,
	}
}

const pickFirstString = (raw: unknown, preferredPaths: RegExp[]): string | null => {
	const values = collectStringValues(raw)
	for (const pathRegex of preferredPaths) {
		const found = values.find((entry) => pathRegex.test(entry.path) && entry.value.trim())
		if (found) return found.value.trim()
	}
	return null
}

const extractTrackingEvents = (raw: unknown): TrackShipmentOutput['events'] => {
	// Try PostNord-specific structure: TrackingInformationResponse.shipments[*].items[*].events[]
	if (isObject(raw)) {
		const tir = (raw as Record<string, unknown>).TrackingInformationResponse
		if (isObject(tir)) {
			const shipments = (tir as Record<string, unknown>).shipments
			if (Array.isArray(shipments) && shipments.length > 0) {
				const events: TrackShipmentOutput['events'] = []
				for (const shipment of shipments) {
					if (!isObject(shipment)) continue
					const items = (shipment as Record<string, unknown>).items
					if (Array.isArray(items)) {
						for (const item of items) {
							if (!isObject(item)) continue
							const itemEvents = (item as Record<string, unknown>).events
							if (Array.isArray(itemEvents)) {
								for (const evt of itemEvents) {
									if (!isObject(evt)) continue
									const e = evt as Record<string, unknown>
									const loc = e.location
									let locStr: string | null = null
									if (isObject(loc)) {
										const l = loc as Record<string, unknown>
										const parts = [l.displayName || l.name || '', l.city || '', l.country || '']
											.map((p) => String(p || '').trim())
											.filter(Boolean)
										locStr = parts.length ? parts.join(', ') : null
									} else if (typeof loc === 'string') {
										locStr = loc || null
									}
									events.push({
										date: typeof e.eventTime === 'string' ? e.eventTime : null,
										status: typeof e.status === 'string' ? e.status : null,
										location: locStr,
										description: typeof e.eventDescription === 'string' ? e.eventDescription : null,
										eventCode: typeof e.eventCode === 'string' ? e.eventCode : null,
									})
								}
							}
						}
					}
				}
				if (events.length > 0) {
					events.sort((a, b) => {
						if (!a.date) return 1
						if (!b.date) return -1
						return a.date.localeCompare(b.date)
					})
					return events
				}
			}
		}
	}

	// Generic fallback walker for other providers
	const events: TrackShipmentOutput['events'] = []

	const walk = (node: unknown) => {
		if (Array.isArray(node)) {
			for (const item of node) walk(item)
			return
		}

		if (!isObject(node)) return

		const status = typeof node.status === 'string' ? node.status : null
		const description = typeof node.description === 'string'
			? node.description
			: typeof node.eventDescription === 'string'
				? node.eventDescription
				: typeof node.text === 'string'
					? node.text
					: null
		const date = typeof node.date === 'string'
			? node.date
			: typeof node.eventDate === 'string'
				? node.eventDate
				: typeof node.eventTime === 'string'
					? node.eventTime
					: typeof node.time === 'string'
						? node.time
						: null
		const locationRaw = node.location
		const location = typeof locationRaw === 'string'
			? locationRaw
			: isObject(locationRaw)
				? ([
					(locationRaw as Record<string, unknown>).displayName,
					(locationRaw as Record<string, unknown>).name,
					(locationRaw as Record<string, unknown>).city,
					(locationRaw as Record<string, unknown>).country,
				]
					.map((p) => String(p || '').trim())
					.filter(Boolean)
					.join(', ') || null)
				: typeof node.city === 'string'
					? node.city
					: null
		const eventCode = typeof node.eventCode === 'string' ? node.eventCode : null

		if (status || description || date || location) {
			events.push({ status, description, date, location, eventCode })
		}

		for (const value of Object.values(node)) {
			walk(value)
		}
	}

	walk(raw)

	const deduped = new Map<string, TrackShipmentOutput['events'][number]>()
	for (const event of events) {
		const key = `${event.date || ''}|${event.status || ''}|${event.location || ''}|${event.description || ''}`
		if (!deduped.has(key)) deduped.set(key, event)
	}

	return Array.from(deduped.values())
}

const collectNumericValues = (node: unknown, currentPath = '$'): Array<{ path: string; value: number }> => {
	if (node == null) return []

	if (typeof node === 'number' && Number.isFinite(node)) {
		return [{ path: currentPath, value: node }]
	}

	if (typeof node === 'string') {
		const normalized = node.trim().replace(',', '.')
		if (/^-?\d+(\.\d+)?$/.test(normalized)) {
			const parsed = Number(normalized)
			if (Number.isFinite(parsed)) {
				return [{ path: currentPath, value: parsed }]
			}
		}
		return []
	}

	if (Array.isArray(node)) {
		return node.flatMap((value, index) => collectNumericValues(value, `${currentPath}[${index}]`))
	}

	if (isObject(node)) {
		return Object.entries(node).flatMap(([key, value]) => collectNumericValues(value, `${currentPath}.${key}`))
	}

	return []
}

const extractCurrency = (raw: unknown): string | null => {
	const maybe = pickFirstString(raw, [
		/\.currency$/i,
		/\.currencycode$/i,
		/\.pricecurrency$/i,
	])
	if (!maybe) return null
	const normalized = maybe.trim().toUpperCase()
	return /^[A-Z]{3}$/.test(normalized) ? normalized : null
}

const parseCostResponse = (raw: unknown): EstimateShipmentCostOutput => {
	const currency = extractCurrency(raw)
	const numerics = collectNumericValues(raw)

	const relevant = numerics.filter((entry) => /price|cost|amount|total|fee|charge/i.test(entry.path))
	const prioritized = relevant.length > 0 ? relevant : numerics

	const breakdown = prioritized
		.filter((entry) => Number.isFinite(entry.value))
		.map((entry) => ({
			label: entry.path,
			amount: entry.value,
			currency,
		}))

	const totalCandidate = prioritized.find((entry) => /total|grand|final|amount$/i.test(entry.path))
	const amount = totalCandidate?.value ?? (prioritized[0]?.value ?? null)

	return {
		amount,
		currency,
		deliveryTime: null,
		breakdown,
		raw,
	}
}

const buildFallbackCostEstimate = (input: EstimateShipmentCostInput): EstimateShipmentCostOutput => {
	const dimensions = {
		lengthCm: toFiniteNumber(input.dimensions?.lengthCm),
		widthCm: toFiniteNumber(input.dimensions?.widthCm),
		heightCm: toFiniteNumber(input.dimensions?.heightCm),
	}
	requirePositiveNumber('dimensions.lengthCm', dimensions.lengthCm)
	requirePositiveNumber('dimensions.widthCm', dimensions.widthCm)
	requirePositiveNumber('dimensions.heightCm', dimensions.heightCm)

	const weightKg = toFiniteNumber(input.weightKg)
	requirePositiveNumber('weightKg', weightKg)

	const volumetricDivisor = getFiniteEnvNumber('SHIPMENT_FALLBACK_VOLUMETRIC_DIVISOR', 5000)
	const baseFee = getFiniteEnvNumber('SHIPMENT_FALLBACK_BASE_FEE', 59)
	const perKgFee = getFiniteEnvNumber('SHIPMENT_FALLBACK_PER_KG_FEE', 14)
	const fuelSurchargePct = getFiniteEnvNumber('SHIPMENT_FALLBACK_FUEL_PCT', 12)
	const currency = (getEnv('SHIPMENT_FALLBACK_CURRENCY') || DEFAULT_FALLBACK_CURRENCY).toUpperCase()

	const volumetricWeightKg = (dimensions.lengthCm * dimensions.widthCm * dimensions.heightCm) / volumetricDivisor
	const billableWeightKg = Math.max(weightKg, volumetricWeightKg)
	const transportFee = roundTo2(billableWeightKg * perKgFee)
	const subtotal = roundTo2(baseFee + transportFee)
	const fuelSurcharge = roundTo2(subtotal * (fuelSurchargePct / 100))
	const amount = roundTo2(subtotal + fuelSurcharge)

	return {
		amount,
		currency,
		deliveryTime: null,
		breakdown: [
			{
				label: 'fallback.baseFee',
				amount: roundTo2(baseFee),
				currency,
			},
			{
				label: 'fallback.transportFee',
				amount: transportFee,
				currency,
			},
			{
				label: 'fallback.fuelSurcharge',
				amount: fuelSurcharge,
				currency,
			},
		],
		raw: {
			source: 'fallback',
			message: 'Estimated using fallback pricing because POSTNORD_COST_ENDPOINT is not configured.',
			billableWeightKg: roundTo2(billableWeightKg),
			volumetricWeightKg: roundTo2(volumetricWeightKg),
			actualWeightKg: roundTo2(weightKg),
			dimensions,
			serviceCode: input.serviceCode || '18',
		},
	}
}

const parseTransitTimeResponse = (raw: unknown): string | null => {
	if (!isObject(raw)) return null

	const strings = collectStringValues(raw)
	const arrivalEntry = strings.find((e) => /timeOfArrival/i.test(e.path))
	if (arrivalEntry?.value) {
		try {
			const d = new Date(arrivalEntry.value)
			if (!isNaN(d.getTime())) {
				return d.toLocaleDateString('en-SE', { weekday: 'short', month: 'short', day: 'numeric' })
			}
		} catch {}
	}

	const numerics = collectNumericValues(raw)
	const transitEntry = numerics.find((e) => /transitTime.*value|transitDays/i.test(e.path))
	if (transitEntry) {
		const days = Math.round(transitEntry.value)
		if (days > 0) {
			const typeEntry = strings.find((e) => /transitTime.*type/i.test(e.path))
			const isBusinessDays = /business/i.test(typeEntry?.value || '')
			return `${days} ${isBusinessDays ? 'business days' : 'days'}`
		}
	}

	const deliveryEntry = strings.find((e) => /deliveryDate|estimatedDelivery/i.test(e.path))
	if (deliveryEntry?.value) {
		try {
			const d = new Date(deliveryEntry.value)
			if (!isNaN(d.getTime())) {
				return d.toLocaleDateString('en-SE', { weekday: 'short', month: 'short', day: 'numeric' })
			}
		} catch {}
	}

	return null
}

const fetchTransitTime = async (input: EstimateShipmentCostInput, serviceCode: string): Promise<string | null> => {
	if (!isTruthyEnv('POSTNORD_ENABLE_TRANSIT_TIME', false)) {
		return null
	}

	if (Date.now() < transitTimeCooldownUntil) {
		return null
	}

	try {
		const senderAddress = input.senderAddress || getDefaultSenderAddress()
		const endpointPath = getEnv('POSTNORD_TRANSIT_TIME_ENDPOINT') || DEFAULT_TRANSIT_TIME_PATH
		const response = await postNordRequest<unknown>({
			method: 'GET',
			path: endpointPath,
			query: {
				originPostCode: senderAddress.postalCode,
				originCountry: String(senderAddress.countryCode || '').trim().toUpperCase().slice(0, 2),
				destinationPostCode: input.address.postalCode,
				destinationCountry: String(input.address.countryCode || '').trim().toUpperCase().slice(0, 2),
				serviceCode,
			},
		})
		return parseTransitTimeResponse(response)
	} catch (error) {
		if (error instanceof ShipmentProviderError && error.statusCode === 429) {
			transitTimeCooldownUntil = Date.now() + 15 * 60 * 1000
			console.warn('[PostNord] transit time rate-limited; skipping transit lookups for 15 minutes.')
		}
		return null
	}
}

const extractFaultCodes = (details: unknown): string[] => {
	if (!isObject(details)) return []
	const compositeFault = details.compositeFault
	if (!isObject(compositeFault)) return []
	const faults = compositeFault.faults
	if (!Array.isArray(faults)) return []

	return faults
		.filter((fault) => isObject(fault))
		.map((fault) => String((fault as Record<string, unknown>).faultCode || '').trim())
		.filter((value) => Boolean(value))
}

const getLabelServiceFallbackCodes = (requestedServiceCode: string): string[] => {
	const raw = getEnv('POSTNORD_LABEL_SERVICE_FALLBACKS') || '19,18,17,15'
	return Array.from(
		new Set(
			raw
				.split(',')
				.map((value) => String(value || '').trim())
				.filter((value) => Boolean(value) && value !== requestedServiceCode),
		),
	)
}

export const generateShipmentLabel = async (input: GenerateShipmentLabelInput): Promise<ShipmentLabelOutput> => {
	if (!input || !isObject(input)) {
		throw new ShipmentProviderError('Input is required for generateShipmentLabel.')
	}

	// Step 1: Book EDI instruction (creates the shipment)
	const bookEdiPath = String(getEnv('POSTNORD_BOOK_EDI_ENDPOINT') || DEFAULT_BOOK_EDI_PATH)

	const requestedServiceCode = String(input.serviceCode || '18').trim() || '18'
	let bookedServiceCode = requestedServiceCode

	const bookWithService = async (serviceCode: string): Promise<unknown> => {
		const payload = input.externalPayload && isObject(input.externalPayload)
			? input.externalPayload
			: buildEdiShipmentPayload({
				...input,
				serviceCode,
			})

		return postNordRequest<unknown>({
			method: 'POST',
			path: bookEdiPath,
			body: payload,
		})
	}

	let bookResponse: unknown
	try {
		bookResponse = await bookWithService(requestedServiceCode)
		bookedServiceCode = requestedServiceCode
	} catch (error) {
		const faultCodes = error instanceof ShipmentProviderError ? extractFaultCodes(error.details) : []
		const shouldRetry =
			error instanceof ShipmentProviderError
			&& error.statusCode === 400
			&& faultCodes.includes('SAI-BR-24111201')

		if (!shouldRetry) {
			throw error
		}

		const fallbackServiceCodes = getLabelServiceFallbackCodes(requestedServiceCode)
		let lastError: unknown = error

		for (const fallbackServiceCode of fallbackServiceCodes) {
			try {
				console.warn('[PostNord EDI] retrying label booking with fallback basicServiceCode', {
					requestedServiceCode,
					fallbackServiceCode,
				})
				bookResponse = await bookWithService(fallbackServiceCode)
				bookedServiceCode = fallbackServiceCode
				break
			} catch (retryError) {
				lastError = retryError
			}
		}

		if (bookResponse == null) {
			throw lastError
		}
	}

	console.log('[PostNord EDI] booking response received', { bookingData: bookResponse })

	// Step 2: Generate label in desired format (PDF or ZPL)
	const labelFormat = String(input.labelFormat || 'PDF').toUpperCase()
	const labelPath = labelFormat === 'ZPL'
		? String(getEnv('POSTNORD_LABEL_ZPL_ENDPOINT') || DEFAULT_LABEL_ZPL_PATH)
		: String(getEnv('POSTNORD_LABEL_PDF_ENDPOINT') || DEFAULT_LABEL_PDF_PATH)

	const labelQuery = labelFormat === 'ZPL'
		? {
				multiZPL: 'false',
				cutter: 'false',
				dpmm: '8dpmm',
				fonts: 'E:ARI000.TTF, E:ARIAL.TTF, E:T0003M_',
				labelType: String(input.labelType || 'standard'),
				labelLength: '190',
				pnInfoText: 'false',
				labelsPerPage: '100',
				page: '1',
				processOffline: 'false',
				storeLabel: 'false',
			}
		: {
				paperSize: String(input.paperSize || 'A4'),
				rotate: '0',
				multiPDF: 'false',
				labelType: String(input.labelType || 'standard'),
				pnInfoText: 'false',
				labelsPerPage: '100',
				page: '1',
				processOffline: 'false',
				storeLabel: 'false',
			}

	const labelPayload = input.externalPayload && isObject(input.externalPayload)
		? input.externalPayload
		: buildEdiShipmentPayload({
			...input,
			serviceCode: bookedServiceCode,
		})

	const labelResponse = await postNordRequest<unknown>({
		method: 'POST',
		path: labelPath,
		query: labelQuery,
		body: labelPayload,
	})

	return parseLabelResponse(labelResponse)
}

export const trackShipment = async (
	trackingNumber: string,
	options?: {
		endpointPath?: string
		language?: string
	},
): Promise<TrackShipmentOutput> => {
	const trimmed = String(trackingNumber || '').trim()
	if (!trimmed) {
		throw new ShipmentProviderError('trackingNumber is required.')
	}

	const endpointPath = String(options?.endpointPath || getEnv('POSTNORD_TRACK_ENDPOINT') || DEFAULT_TRACK_PATH)

	const response = await postNordRequest<unknown>({
		method: 'GET',
		path: endpointPath,
		query: {
			id: trimmed,
			locale: options?.language || getEnv('POSTNORD_TRACK_LOCALE') || undefined,
		},
	})

	const status = pickFirstString(response, [
		/\.status$/i,
		/\.statuscode$/i,
		/\.currentstatus$/i,
	])
	const statusDescription = pickFirstString(response, [
		/\.statusdescription$/i,
		/\.description$/i,
		/\.statusmessage$/i,
	])
	const estimatedDelivery = pickFirstString(response, [
		/estimated.*delivery/i,
		/delivery.*date/i,
		/eta/i,
	])

	const events = extractTrackingEvents(response)

	// Extract PostNord-specific enriched fields from TrackingInformationResponse
	let shipmentId: string | null = null
	let service: TrackShipmentOutput['service'] = null
	let statusText: TrackShipmentOutput['statusText'] = null
	let deliveryDate: string | null = null
	let weight: TrackShipmentOutput['weight'] = null
	let consignor: TrackShipmentOutput['consignor'] = null
	let consignee: TrackShipmentOutput['consignee'] = null

	if (isObject(response)) {
		const tir = (response as Record<string, unknown>).TrackingInformationResponse
		if (isObject(tir)) {
			const shipments = (tir as Record<string, unknown>).shipments
			if (Array.isArray(shipments) && shipments.length > 0 && isObject(shipments[0])) {
				const s = shipments[0] as Record<string, unknown>
				shipmentId = typeof s.shipmentId === 'string' ? s.shipmentId : null
				const svc = s.service
				if (isObject(svc)) {
					const sv = svc as Record<string, unknown>
					service = {
						code: typeof sv.code === 'string' ? sv.code : null,
						name: typeof sv.name === 'string' ? sv.name : null,
					}
				}
				const st = s.statusText
				if (isObject(st)) {
					const stObj = st as Record<string, unknown>
					statusText = {
						header: typeof stObj.header === 'string' ? stObj.header : null,
						body: typeof stObj.body === 'string' ? stObj.body : null,
					}
				}
				deliveryDate = typeof s.deliveryDate === 'string' ? s.deliveryDate : null
				const tw = s.totalWeight
				if (isObject(tw)) {
					const twObj = tw as Record<string, unknown>
					weight = {
						value: typeof twObj.value === 'string' ? twObj.value : (twObj.value != null ? String(twObj.value) : null),
						unit: typeof twObj.unit === 'string' ? twObj.unit : null,
					}
				}
				const cgr = s.consignor
				if (isObject(cgr)) {
					const cgrObj = cgr as Record<string, unknown>
					const addr = cgrObj.address
					const cgrCountry = isObject(addr) ? String((addr as Record<string, unknown>).country || '') || null : null
					consignor = {
						name: typeof cgrObj.name === 'string' ? cgrObj.name : null,
						country: cgrCountry,
					}
				}
				const cge = s.consignee
				if (isObject(cge)) {
					const cgeObj = cge as Record<string, unknown>
					const addr = cgeObj.address
					if (isObject(addr)) {
						const addrObj = addr as Record<string, unknown>
						consignee = {
							country: typeof addrObj.country === 'string' ? addrObj.country : null,
							postCode: typeof addrObj.postCode === 'string' ? addrObj.postCode : null,
						}
					}
				}
			}
		}
	}

	return {
		trackingNumber: trimmed,
		status,
		statusDescription,
		estimatedDelivery,
		events,
		raw: response,
		shipmentId,
		service,
		statusText,
		deliveryDate,
		weight,
		consignor,
		consignee,
	}
}

export const estimateShipmentCost = async (
	input: EstimateShipmentCostInput,
): Promise<EstimateShipmentCostOutput> => {
	if (!input || !isObject(input)) {
		throw new ShipmentProviderError('Input is required for estimateShipmentCost.')
	}

	let costResult: EstimateShipmentCostOutput
	const portalPricingEnabled = isTruthyEnv('POSTNORD_USE_PORTAL_PRICING', false) && !portalPricingDisabledForSession

	if (!portalPricingEnabled) {
		if (isPostNordDebugLogsEnabled()) {
			console.log('[PostNord Portal] shipment fare using fallback estimate (no API call)', {
				reason: portalPricingDisabledForSession ? 'portal-pricing-disabled-for-session' : 'POSTNORD_USE_PORTAL_PRICING=false',
			})
		}
		costResult = buildFallbackCostEstimate(input)
	} else if (input.externalPayload && isObject(input.externalPayload)) {
		// Custom external payload provided — send as-is to the portal
		const portalResponse = await portalRequest<unknown>({
			method: 'POST',
			path: input.endpointPath || DEFAULT_COST_PORTAL_PATH,
			body: input.externalPayload,
		}).catch((err) => {
			if (err instanceof ShipmentProviderError && err.statusCode === 401) {
				portalPricingDisabledForSession = true
				console.warn('[PostNord Portal] unauthorized; disabling portal pricing for the rest of this server session.')
			}
			console.warn('[PostNord Portal] external payload request failed, using fallback.', { message: err?.message })
			return null
		})
		costResult = portalResponse ? parseCostResponse(portalResponse) : buildFallbackCostEstimate(input)
	} else {
		// Build portal-format payload and call PostNord Portal pricing API
		const portalPayload = buildPortalCostPayload(input)
		const portalResponse = await portalRequest<unknown>({
			method: 'POST',
			path: DEFAULT_COST_PORTAL_PATH,
			body: portalPayload,
		}).catch((err) => {
			if (err instanceof ShipmentProviderError && err.statusCode === 401) {
				portalPricingDisabledForSession = true
				console.warn('[PostNord Portal] unauthorized; disabling portal pricing for the rest of this server session.')
			}
			console.warn('[PostNord Portal] pricing request failed, using fallback estimate.', { message: err?.message })
			return null
		})
		costResult = portalResponse ? parseCostResponse(portalResponse) : buildFallbackCostEstimate(input)
	}

	// Supplement with transit time delivery estimate
	const serviceCode = String(input.serviceCode || '18')
	const deliveryTime = await fetchTransitTime(input, serviceCode)
	if (deliveryTime) costResult.deliveryTime = deliveryTime

	return costResult
}

