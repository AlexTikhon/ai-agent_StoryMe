/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Playwright serves the local dev app on the numeric loopback host. Newer
  // Next.js releases reject that dev-resource origin unless it is explicit.
  allowedDevOrigins: ['127.0.0.1'],

  images: {
    remotePatterns: [
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '9000',
        pathname: '/**',
      },
    ],
  },
};

export default nextConfig;
