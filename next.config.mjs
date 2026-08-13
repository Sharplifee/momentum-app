/** @type {import('next').NextConfig} */
const nextConfig = {
  // The customer app is a static page plus its own API. The page is served from
  // public/ so it stays byte-identical to what Claude Design produces — Next
  // never parses or rewrites it.
  async rewrites() {
    return [{ source: "/app", destination: "/app/index.html" }];
  },
};
export default nextConfig;
