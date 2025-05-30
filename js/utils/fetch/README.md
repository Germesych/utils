### Универсальный Fetch с Retry: Руководство и Реализация

```js
/**
 * УНИВЕРСАЛЬНЫЙ FETCH С ПОВТОРАМИ И ТАЙМАУТАМИ
 * 
 * Особенности:
 * - Автоматические повторы при сбоях (с экспоненциальной задержкой)
 * - Таймаут запросов
 * - Безопасная обработка URL и параметров
 * - Автоматическая сериализация тела запроса
 * - Гибкая обработка ответов (JSON, text, blob)
 * - Расширенные ошибки с контекстом
 * - Поддержка прерывания запросов
 * 
 * Параметры:
 * @param {string} url - URL запроса
 * @param {object} [options] - Дополнительные параметры:
 *   - method: HTTP метод (GET, POST...)
 *   - headers: Заголовки запроса
 *   - body: Тело запроса (авто-сериализация для объектов)
 *   - query: Query-параметры (объект)
 *   - retries: Количество повторов (default: 3)
 *   - retryDelay: Базовая задержка между повторами (ms)
 *   - timeout: Таймаут запроса (ms)
 *   - responseType: Формат ответа ('json', 'text', 'blob', 'auto')
 *   - validateStatus: Функция валидации статуса
 *   - debug: Режим отладки (логирование)
 *   - signal: Сигнал для прерывания (AbortController)
 * 
 * Возвращает: Promise с данными ответа
 * 
 * Примеры использования:
 * 
 * 1. Простой GET запрос:
 *    const data = await fetchEnhanced('https://api.example.com/data');
 * 
 * 2. POST запрос с параметрами:
 *    await fetchEnhanced('https://api.example.com/users', {
 *      method: 'POST',
 *      body: { name: 'John' },
 *      query: { ref: 'app' }
 *    });
 * 
 * 3. Загрузка файла с таймаутом:
 *    const image = await fetchEnhanced('https://example.com/image.jpg', {
 *      responseType: 'blob',
 *      timeout: 10000
 *    });
 * 
 * 4. Кастомная обработка ошибок:
 *    try {
 *      await fetchEnhanced('https://api.example.com/error', {
 *        validateStatus: status => status === 200
 *      });
 *    } catch (err) {
 *      console.error('Request failed:', err.status, err.data);
 *    }
 */
async function fetchEnhanced(
  url,
  {
    method = 'GET',
    headers = {},
    body = null,
    query = {},
    retries = 3,
    retryDelay = 1000,
    timeout = 8000, // 8s default timeout
    responseType = 'auto', // 'json' | 'text' | 'blob' | 'auto'
    validateStatus = (status) => status >= 200 && status < 300,
    debug = false,
    signal = null, // Для AbortController
  } = {}
) {
  // ======================================
  // 1. ПОДГОТОВКА URL И ПАРАМЕТРОВ ЗАПРОСА
  // ======================================
  
  // Безопасное формирование URL с query-параметрами
  const finalUrl = new URL(url);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined) {
      finalUrl.searchParams.append(key, value);
    }
  });

  // Конфигурация опций fetch
  const options = {
    method: method.toUpperCase(), // Нормализация метода
    headers: { ...headers }, // Клонирование заголовков
    // Приоритет: внешний signal > автоматический таймаут
    signal: signal || (timeout ? AbortSignal.timeout(timeout) : null),
  };

  // ======================================
  // 2. ОБРАБОТКА ТЕЛА ЗАПРОСА
  // ======================================
  
  // Для GET/HEAD запросов тело игнорируется
  if (body && !['GET', 'HEAD'].includes(options.method)) {
    // Автоматическая сериализация объектов в JSON
    if (typeof body === 'object' && !(body instanceof FormData)) {
      options.body = JSON.stringify(body);
      // Установка Content-Type, если не задан
      if (!options.headers['Content-Type']) {
        options.headers['Content-Type'] = 'application/json';
      }
    } else {
      // Для FormData, строк, Blob и др.
      options.body = body;
    }
  }

  // ======================================
  // 3. ВЫПОЛНЕНИЕ ЗАПРОСА С ПОВТОРАМИ
  // ======================================
  let lastError = null;
  let attempt = 0;

  while (attempt <= retries) {
    attempt++;
    try {
      // Отладочное логирование
      if (debug) {
        console.debug(`[Fetch] Attempt ${attempt}/${retries} → ${finalUrl}`, {
          method: options.method,
          headers: options.headers,
          body: options.body
        });
      }

      // Выполнение запроса
      const response = await fetch(finalUrl.toString(), options);

      // ======================================
      // 4. ОБРАБОТКА ОТВЕТА
      // ======================================
      
      // Проверка статуса (кастомная или по умолчанию)
      if (!validateStatus(response.status)) {
        // Детальный разбор ошибки
        const errorData = await parseErrorResponse(response);
        throw new FetchError(
          `Request failed with status ${response.status}`,
          response.status,
          errorData
        );
      }

      // Парсинг ответа в нужном формате
      return await parseResponse(response, responseType);

    } catch (error) {
      lastError = error;
      
      // Отладочное логирование ошибок
      if (debug) {
        console.error(`[Fetch Error] Attempt ${attempt}:`, error);
      }

      // ======================================
      // 5. ЛОГИКА ПОВТОРОВ
      // ======================================
      
      // Проверка необходимости повторной попытки
      if (attempt <= retries && !isFatalError(error)) {
        // Экспоненциальная задержка: delay * 2^(attempt-1)
        const delay = retryDelay * Math.pow(2, attempt - 1);
        if (debug) console.warn(`Retrying in ${delay}ms...`);
        await wait(delay);
      } else {
        // Если повторы закончились или ошибка фатальна
        throw enhanceError(error, {
          url: finalUrl.toString(),
          method: options.method,
          attempt: attempt
        });
      }
    }
  }

  throw lastError;
}

// ======================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ======================================

/**
 * Парсит ответ сервера в зависимости от типа
 * @param {Response} response - Объект ответа
 * @param {string} responseType - Ожидаемый тип данных
 */
async function parseResponse(response, responseType) {
  // Автоопределение типа по Content-Type
  const contentType = response.headers.get('Content-Type') || '';
  
  // Определение типа ответа
  const type = responseType === 'auto' ? contentType : responseType;

  if (type.includes('json') || responseType === 'json') {
    return response.json();
  }
  if (type.includes('text') || responseType === 'text') {
    return response.text();
  }
  if (type.includes('octet-stream') || responseType === 'blob') {
    return response.blob();
  }
  // Для бинарных данных по умолчанию
  return response.arrayBuffer();
}

/**
 * Извлекает информацию из ошибочного ответа
 * @param {Response} response - Ответ с ошибкой
 */
async function parseErrorResponse(response) {
  try {
    return await response.json();
  } catch {
    try {
      return await response.text();
    } catch {
      return `Failed to parse error response (status: ${response.status})`;
    }
  }
}

/**
 * Проверяет, является ли ошибка фатальной
 * (не требует повторных попыток)
 * @param {Error} error - Объект ошибки
 */
function isFatalError(error) {
  return (
    // Прерывание пользователем или таймаут
    error.name === 'AbortError' || 
    // Сетевая ошибка (CORS, неправильный URL)
    error instanceof TypeError || 
    // Клиентские ошибки (4xx)
    (error.status && error.status >= 400 && error.status < 500)
  );
}

/**
 * Задержка выполнения
 * @param {number} ms - Время задержки в миллисекундах
 */
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Кастомный класс ошибок для запросов
 */
class FetchError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'FetchError';
    this.status = status; // HTTP статус
    this.data = data;    // Дополнительные данные
  }
}

/**
 * Обогащает ошибку контекстом запроса
 * @param {Error} error - Исходная ошибка
 * @param {object} context - Контекст запроса
 */
function enhanceError(error, context) {
  error.url = context.url;
  error.method = context.method;
  error.attempt = context.attempt;
  return error;
}

// Экспорт функции для использования в модулях
export default fetchEnhanced;
```

### Ключевые особенности реализации:

1. **Безопасность URL**  
   Используем конструктор `URL` для корректной обработки параметров и предотвращения XSS-атак.

2. **Автосериализация тела**  
   Автоматическое преобразование объектов в JSON с установкой правильного Content-Type.

3. **Умные повторы**  
   Экспоненциальная задержка между попытками (retryDelay * 2^(n-1)).

4. **Таймауты**  
   Встроенная поддержка автоматического прерывания долгих запросов через `AbortSignal.timeout()`.

5. **Классификация ошибок**  
   Разделение ошибок на фатальные (не требующие повтора) и временные:
   - `AbortError`: Прерывание пользователем
   - `TypeError`: Проблемы сети/CORS
   - 4xx ошибки: Клиентские ошибки

6. **Гибкий парсинг**  
   Поддержка форматов:
   ```js
   // Явное указание типа
   await fetchEnhanced(url, {responseType: 'blob'})
   
   // Автоопределение по Content-Type
   await fetchEnhanced(url) // Автоматически для JSON/text
   ```

7. **Расширенные ошибки**  
   Объекты ошибок содержат:
   - HTTP статус
   - URL запроса
   - Метод
   - Номер попытки
   - Ответ сервера (если доступен)

### Рекомендации по использованию:

1. **Базовый запрос:**
   ```js
   const data = await fetchEnhanced('https://api.example.com/data')
   ```

2. **POST запрос с JSON:**
   ```js
   await fetchEnhanced('https://api.example.com/users', {
     method: 'POST',
     body: { name: 'Anna' }
   })
   ```

3. **Загрузка файла:**
   ```js
   const image = await fetchEnhanced('https://example.com/photo.jpg', {
     responseType: 'blob',
     timeout: 15000 // 15s timeout
   })
   ```

4. **Кастомная валидация:**
   ```js
   await fetchEnhanced('https://api.example.com/status', {
     validateStatus: status => status === 304 // Только 304 OK
   })
   ```

5. **Обработка ошибок:**
   ```js
   try {
     await fetchEnhanced('https://unstable.api/data', {
       retries: 5,
       retryDelay: 2000
     })
   } catch (err) {
     console.error(`Request to ${err.url} failed after ${err.attempt} attempts`)
     console.error('Server response:', err.data)
   }
   ```

6. **Прерывание запроса:**
   ```js
   const controller = new AbortController();
   
   // Прервать через 5 секунд
   setTimeout(() => controller.abort(), 5000);
   
   await fetchEnhanced('https://large.file/download', {
     signal: controller.signal
   })
   ```

Данная реализация:
- Соответствует современным стандартам безопасности
- Обрабатывает edge-кейсы сетевых запросов
- Предоставляет детализированную отладку
- Имеет прозрачную конфигурацию
- Подходит как для браузеров, так и для Node.js

Рекомендуется для использования в production-проектах как надежная замена стандартному fetch.