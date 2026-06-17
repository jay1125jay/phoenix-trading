const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function(app) {
  app.use(
    '/binance',
    createProxyMiddleware({
      target: 'https://api.binance.com',
      changeOrigin: true,
      pathRewrite: { '^/binance': '' },
    })
  );
  app.use(
    '/feargreed',
    createProxyMiddleware({
      target: 'https://api.alternative.me',
      changeOrigin: true,
      pathRewrite: { '^/feargreed': '' },
    })
  );
};