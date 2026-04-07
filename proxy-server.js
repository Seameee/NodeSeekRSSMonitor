// ============================================================================
// 简单的 HTTP 代理转发服务（用于部署在 VPS 上）
// 配合 Cloudflare Workers 使用，解决 RSS 源访问问题
// ============================================================================

const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || ''; // 可选：设置 API_KEY 保护代理

const server = http.createServer(async (req, res) => {
  // CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 解析 URL
  const parsedUrl = url.parse(req.url, true);
  const targetUrl = parsedUrl.query.url;

  // 验证 API_KEY（如果配置了）
  if (API_KEY && parsedUrl.query.key !== API_KEY) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or missing API key' }));
    return;
  }

  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing url parameter' }));
    return;
  }

  // 验证目标 URL（只允许 http/https）
  let targetParsed;
  try {
    targetParsed = new URL(targetUrl);
    if (!['http:', 'https:'].includes(targetParsed.protocol)) {
      throw new Error('Invalid protocol');
    }
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid target URL' }));
    return;
  }

  console.log(`[${new Date().toISOString()}] Proxying: ${targetUrl}`);

  // 转发请求
  const options = {
    hostname: targetParsed.hostname,
    port: targetParsed.port || (targetParsed.protocol === 'https:' ? 443 : 80),
    path: targetParsed.pathname + targetParsed.search,
    method: 'GET',
    headers: {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'identity', // 不压缩，直接转发
    },
    timeout: 30000, // 30秒超时
  };

  const client = targetParsed.protocol === 'https:' ? https : http;

  const proxyReq = client.request(options, (proxyRes) => {
    // 转发状态码和响应头
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': proxyRes.headers['content-type'] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });

    // 流式转发响应体
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy request error:', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Proxy request failed', message: err.message }));
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    res.writeHead(504, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Gateway timeout' }));
  });

  proxyReq.end();
});

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║        RSS Proxy Server for NodeSeek Monitor           ║
╚════════════════════════════════════════════════════════╝

Port: ${PORT}
API Key: ${API_KEY ? 'Enabled (set in PROXY_URL as ?key=xxx)' : 'Disabled'}

Usage:
  http://localhost:${PORT}/proxy?url=https://rss.nodeseek.com/

Environment Variables:
  PORT     - Server port (default: 3000)
  API_KEY  - Optional API key for authentication

Example Worker config:
  PROXY_URL=https://your-vps.com/proxy
  or with API key:
  PROXY_URL=https://your-vps.com/proxy?key=your-secret-key
`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
