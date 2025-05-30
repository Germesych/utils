async function fetchEnhanced(
  url,
  {
    method = 'GET',
    headers = {},
    body = null,
    query = {},
    retries = 3,
    retryDelay = 1000,
    timeout = 8000,
    responseType = 'auto', // 'json', 'text', 'blob', 'auto'
    validateStatus = (status) => status >= 200 && status < 300,
    debug = false,
    signal = null,
  } = {}
) {
  // Query parameters handling
  const finalUrl = new URL(url);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined) {
      finalUrl.searchParams.append(key, value);
    }
  });

  // Request configuration
  const options = {
    method: method.toUpperCase(),
    headers: { ...headers },
    signal: signal || (timeout ? AbortSignal.timeout(timeout) : null),
  };

  // Body handling (auto-serialization and safety)
  if (body && !['GET', 'HEAD'].includes(options.method)) {
    if (typeof body === 'object' && !(body instanceof FormData)) {
      options.body = JSON.stringify(body);
      options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json';
    } else {
      options.body = body;
    }
  }

  let lastError = null;
  let attempt = 0;

  while (attempt <= retries) {
    attempt++;
    try {
      if (debug) {
        console.debug(`[Fetch] Attempt ${attempt}/${retries}`, {
          url: finalUrl.toString(),
          options
        });
      }

      const response = await fetch(finalUrl.toString(), options);

      // Status validation
      if (!validateStatus(response.status)) {
        const errorData = await parseErrorResponse(response);
        throw new FetchError(
          `Request failed with status ${response.status}`,
          response.status,
          errorData
        );
      }

      // Response parsing
      return await parseResponse(response, responseType);

    } catch (error) {
      lastError = error;

      if (debug) {
        console.error(`[Fetch Error] Attempt ${attempt}:`, error);
      }

      // Retry logic
      if (attempt <= retries && !isFatalError(error)) {
        await wait(retryDelay * Math.pow(2, attempt - 1)); // Exponential backoff
      } else {
        throw enhanceError(error, {
          url: finalUrl.toString(),
          method,
          attempt
        });
      }
    }
  }

  throw lastError;
}

// Helper functions
async function parseResponse(response, responseType) {
  const type = responseType === 'auto' 
    ? response.headers.get('Content-Type') || ''
    : responseType;

  if (type.includes('json') || responseType === 'json') {
    return response.json();
  }
  if (type.includes('text') || responseType === 'text') {
    return response.text();
  }
  if (type.includes('octet-stream') || responseType === 'blob') {
    return response.blob();
  }
  return response.arrayBuffer();
}

async function parseErrorResponse(response) {
  try {
    return await response.json();
  } catch {
    try {
      return await response.text();
    } catch {
      return null;
    }
  }
}

function isFatalError(error) {
  return error.name === 'AbortError' || 
         error instanceof TypeError || 
         (error.status && error.status >= 400 && error.status < 500);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class FetchError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'FetchError';
    this.status = status;
    this.data = data;
  }
}

function enhanceError(error, context) {
  error.url = context.url;
  error.method = context.method;
  error.attempt = context.attempt;
  return error;
}
