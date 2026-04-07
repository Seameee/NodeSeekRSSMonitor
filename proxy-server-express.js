// ============================================================================
// Express 版本的 HTTP 代理转发服务（更现代、更易部署）
// 配合 Cloudflare Workers 使用，解决 RSS 源访问问题
// ============================================================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || ''; // 可选：设置 API_KEY 保护代理

// 中间件
app.use(cors());
app.use(express.json());

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 代理端点
app.get('/proxy', async (req, res) => {
  // 验证 API_KEY（如果配置了）
  if (API_KEY && req.query.key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }

  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  // 验证目标 URL
  let targetParsed;
  try {
    targetParsed = new URL(targetUrl);
    if (!['http:', 'https:'].includes(targetParsed.protocol)) {
      throw new Error('Invalid protocol');
    }
  } catch (e) {
    return res.status(400).json({ error: 'Invalid target URL' });
  }

  console.log(`[${new Date().toISOString()}] Proxying: ${targetUrl}`);

  try {
    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      timeout: 30000,
      responseType: 'text',
      // 自动处理重定向
      maxRedirects: 5,
    });

    // 转发响应
    res.set('Content-Type', response.headers['content-type'] || 'text/html');
    res.set('Cache-Control', 'no-cache');
    res.status(response.status).send(response.data);

    console.log(`[${new Date().toISOString()}] Success: ${targetUrl} (${response.status})`);

  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(502).json({
      error: 'Proxy request failed',
      message: error.message,
      code: error.code,
    });
  }
});

// 根路径说明
app.get('/', (req, res) => {
  res.json({
    name: 'RSS Proxy for NodeSeek Monitor',
    endpoints: {
      '/health': 'Health check',
      '/proxy?url=URL': 'Proxy request to URL',
    },
    usage: 'GET /proxy?url=https://rss.nodeseek.com/',
  });
});

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║    Express RSS Proxy Server (NodeSeek Monitor)         ║
╚════════════════════════════════════════════════════════╝

Port: ${PORT}
API Key: ${API_KEY ? 'Enabled' : 'Disabled'}

Endpoints:
  GET /health          - Health check
  GET /proxy?url=XXX   - Proxy to target URL

Usage:
  curl "http://localhost:${PORT}/proxy?url=https://rss.nodeseek.com/"

Environment Variables:
  PORT     - Server port (default: 3000)
  API_KEY  - Optional API key for authentication

Deploy with PM2:
  npm install pm2 -g
  pm2 start proxy-server-express.js --name rss-proxy

Deploy with Docker:
  docker build -t rss-proxy .
  docker run -p 3000:3000 -e API_KEY=your-key rss-proxy
`);
});
