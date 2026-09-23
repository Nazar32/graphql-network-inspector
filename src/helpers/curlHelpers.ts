/**
 * Formats request body with proper escaping and unicode handling
 * @param text - Raw request body text
 * @returns Formatted body string with proper escaping
 */
const formatBody = (text: string): string => {
  // Handle multipart form data
  if (text.includes('Content-Type: multipart/form-data')) {
    return text
      .split('\r\n')
      .map((line) => line.replace(/'/g, "'\\''"))
      .join('\\r\\n')
  }

  // Handle binary data using character codes
  const hasBinaryData = Array.from(text).some((char) => {
    const code = char.charCodeAt(0)
    return code <= 8 || (code >= 14 && code <= 31)
  })

  if (hasBinaryData) {
    return Buffer.from(text).toString('base64')
  }

  // Normal JSON handling
  try {
    const body = JSON.parse(text)
    return JSON.stringify(body).replace(
      /[^\x20-\x7E]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
    )
  } catch {
    return text
  }
}

/**
 * Generates a cURL command from a network request
 * Matches Chrome DevTools cURL format including:
 * - Header filtering (excludes pseudo headers)
 * - Unicode escaping
 * - Proper quoting and line continuation
 *
 * @example
 * ```typescript
 * const curl = await getNetworkCurl(request)
 * // curl 'https://api.example.com/graphql' \
 * //   -H 'content-type: application/json' \
 * //   --data-raw $'{"query":"query { test }"}'
 * ```
 */
import { ICompleteNetworkRequest } from './networkHelpers'

// Headers that Chrome DevTools excludes
const EXCLUDED_HEADERS = [
  ':authority',
  ':method',
  ':path',
  ':scheme',
  'content-length',
  'accept-encoding',
]

/**
 * Rebuild the request body from the parsed GraphQL payload.
 *
 * This is only used when Chrome did not give us the raw body. The parsed
 * payload carries an extra `id` field that we add for the UI, so remove it.
 *
 * @param request the network request
 * @returns the request body as JSON, or undefined if there is no payload
 */
const getFallbackBody = (
  request: ICompleteNetworkRequest
): string | undefined => {
  const payloads = request?.request?.body
  if (!payloads || !payloads.length) {
    return undefined
  }

  const cleaned = payloads.map(({ query, variables, operationName, extensions }) => ({
    ...(query ? { query } : {}),
    ...(operationName ? { operationName } : {}),
    ...(variables ? { variables } : {}),
    ...(extensions ? { extensions } : {}),
  }))

  return JSON.stringify(cleaned.length === 1 ? cleaned[0] : cleaned)
}

export const getNetworkCurl = async (
  request: ICompleteNetworkRequest
): Promise<string> => {
  // Prefer Chrome's network request data, because it carries the headers
  // exactly as they went on the wire. It is missing when the response was
  // never paired with the request, so fall back to the data we collected
  // from the webRequest api.
  const chromeRequest = request?.native?.networkRequest

  const url = chromeRequest?.request?.url || request?.url
  const method = chromeRequest?.request?.method || request?.method
  const headers = chromeRequest?.request?.headers || request?.request?.headers
  const body =
    chromeRequest?.request?.postData?.text ?? getFallbackBody(request)

  if (!url || !method) {
    console.warn('No Chrome request data available')
    return ''
  }

  const parts: string[] = []

  // Start with curl and URL
  parts.push(`curl '${url}'`)

  // Add headers, filtering out excluded ones
  ;(headers || [])
    .filter((header) => !EXCLUDED_HEADERS.includes(header.name.toLowerCase()))
    .forEach((header) => {
      parts.push(`-H '${header.name}: ${header.value}'`)
    })

  // Add method if not GET
  if (method !== 'GET') {
    parts.push(`-X ${method}`)
  }

  // Add body with proper escaping
  if (body) {
    const formattedBody = formatBody(body)
    parts.push(`--data-raw '${formattedBody}'`)
  }

  return parts.join(' \\\n  ')
}
