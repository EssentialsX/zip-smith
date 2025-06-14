import { BlobWriter, ZipWriter } from '@zip.js/zip.js';

interface JarRequest {
  files: Array<{
    url: string;
    filename: string;
  }>;
  zipFilename?: string;
}

interface CachedZipData {
  data: ArrayBuffer;
  etag: string;
  timestamp: number;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }

    try {
      if (request.method === 'POST') {
        return await handlePostRequest(request, ctx);
      } else {
        return new Response('Method not allowed', { status: 405 });
      }
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(`Internal Server Error: ${error instanceof Error ? error.message : 'Unknown error'}`, {
        status: 500,
        headers: {
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }
} satisfies ExportedHandler<Env>;

async function handlePostRequest(request: Request, ctx: ExecutionContext): Promise<Response> {
  const body: JarRequest = await request.json();

  if (!body.files || !Array.isArray(body.files) || body.files.length === 0) {
    return new Response('Invalid request: files array is required', {
      status: 400,
      headers: {
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  // Validate files
  const validFiles: Array<{ url: string; filename: string }> = [];
  for (const file of body.files) {
    if (!file.url || !file.filename) {
      return new Response('Each file must have both url and filename properties', {
        status: 400,
        headers: {
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // Validate URL format
    try {
      const parsedUrl = new URL(file.url);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return new Response(`Invalid URL protocol: ${file.url}`, {
          status: 400,
          headers: {
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    } catch (e) {
      return new Response(`Invalid URL format: ${file.url}`, {
        status: 400,
        headers: {
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    const allowedPrefixes = [
      'https://github.com/EssentialsX/Essentials/',
      'https://ci.ender.zone/job/EssentialsX/'
    ];

    const isAllowedSource = allowedPrefixes.some(prefix => file.url.startsWith(prefix));
    if (!isAllowedSource) {
      return new Response(`URL must start with one of the allowed EssentialsX sources: ${allowedPrefixes.join(', ')}. Got: ${file.url}`, {
        status: 400,
        headers: {
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // Ensure filename ends with .jar
    const filename = file.filename.toLowerCase().endsWith('.jar')
      ? file.filename
      : file.filename + '.jar';

    validFiles.push({ url: file.url, filename });
  }

  if (validFiles.length === 0) {
    return new Response('No valid files provided', {
      status: 400,
      headers: {
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  // Generate cache key based on sorted file objects
  const sortedFiles = [...validFiles].sort((a, b) => a.url.localeCompare(b.url));
  const cacheKey = await generateCacheKey(sortedFiles.map(f => `${f.url}|${f.filename}`));

  // Check if we have a cached version
  const cached = await getCachedZip(cacheKey);
  if (cached) {
    console.log('Returning cached ZIP for key:', cacheKey);
    return createZipResponse(cached.data, cached.etag, body.zipFilename);
  }

  // Download and create ZIP
  console.log('Creating new ZIP for files:', validFiles);
  const zipData = await createZipFromFiles(validFiles);
  const etag = await generateETag(zipData);

  // Cache the result
  ctx.waitUntil(cacheZip(cacheKey, zipData, etag));

  return createZipResponse(zipData, etag, body.zipFilename);
}

async function generateCacheKey(urls: string[]): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(urls.join('|'));
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function generateETag(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

async function getCachedZip(cacheKey: string): Promise<CachedZipData | null> {
  try {
    const cache = await caches.open('jar-proxy:zips');
    const cacheRequest = new Request(`https://jar-proxy.cache/zip/${cacheKey}`);
    const response = await cache.match(cacheRequest);

    if (response) {
      const data = await response.arrayBuffer();
      const etag = response.headers.get('etag') || '';
      const timestamp = parseInt(response.headers.get('x-timestamp') || '0');

      return { data, etag, timestamp };
    }

    return null;
  } catch (error) {
    console.error('Error getting cached zip:', error);
    return null;
  }
}

async function cacheZip(cacheKey: string, data: ArrayBuffer, etag: string): Promise<void> {
  try {
    const cache = await caches.open('jar-proxy:zips');
    const cacheRequest = new Request(`https://jar-proxy.cache/zip/${cacheKey}`);
    const response = new Response(data, {
      headers: {
        'Content-Type': 'application/zip',
        'etag': etag,
        'x-timestamp': Date.now().toString(),
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    });

    await cache.put(cacheRequest, response);
    console.log('Cached ZIP with key:', cacheKey);
  } catch (error) {
    console.error('Error caching zip:', error);
  }
}

async function createZipFromFiles(files: Array<{ url: string; filename: string }>): Promise<ArrayBuffer> {
  const downloads = await Promise.allSettled(
    files.map(async (file) => {
      const response = await fetch(file.url, {
        headers: {
          'User-Agent': 'Cloudflare-Worker-JAR-Proxy/1.0'
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to download ${file.url}: ${response.status} ${response.statusText}`);
      }

      const data = await response.arrayBuffer();

      return { filename: file.filename, data };
    })
  );

  const failed = downloads.filter(result => result.status === 'rejected');
  if (failed.length > 0) {
    const errors = failed.map(f => (f as PromiseRejectedResult).reason.message).join(', ');
    throw new Error(`Failed to download some files: ${errors}`);
  }

  const downloadedFiles = downloads
    .filter(result => result.status === 'fulfilled')
    .map(result => (result as PromiseFulfilledResult<{ filename: string; data: ArrayBuffer }>).value);

  return await createZip(downloadedFiles);
}

async function createZip(files: { filename: string; data: ArrayBuffer }[]): Promise<ArrayBuffer> {
  const zipWriter = new ZipWriter(new BlobWriter());

  await Promise.all(
    files.map(file =>
      zipWriter.add(file.filename, new Blob([file.data]).stream())
    )
  );

  const zipBlob = await zipWriter.close();

  return await zipBlob.arrayBuffer();
}

function createZipResponse(data: ArrayBuffer, etag: string, filename?: string): Response {
  const zipFilename = filename || 'jars.zip';

  return new Response(data, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipFilename}"`,
      'ETag': etag,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
