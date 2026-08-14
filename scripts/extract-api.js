/**
 * Extract every HTTP endpoint from the Express route files into structured
 * JSON, for the generated API reference (see generate-api-doc.js).
 *
 * Rather than importing the app (which would need a DB + Redis running), this
 * parses the `*.routes.js` sources directly. Route registrations in this
 * codebase follow one consistent shape:
 *
 *     router.get('/partner/mine', partnerOnly, validate(schema), controller.fn);
 *
 * so a line-oriented parse is reliable and dependency-free. Mount prefixes come
 * from src/routes/index.js, and access levels are inferred from the guard
 * arrays each module declares (customerOnly / adminOnly / partnerOnly ...).
 *
 * Run:  node scripts/extract-api.js
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const ROUTES_INDEX = path.join(SRC, 'routes', 'index.js');

/// `router.use('/bookings', bookingRoutes)` → { bookingRoutes: '/bookings' }
const readMounts = () => {
  const text = fs.readFileSync(ROUTES_INDEX, 'utf8');
  const mounts = [];
  const re = /router\.use\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g;
  let m;
  while ((m = re.exec(text))) mounts.push({ prefix: m[1], varName: m[2] });

  /// Map the imported variable back to its file so we know which routes file
  /// each prefix belongs to.
  const importRe = /const\s+(\w+)\s*=\s*require\('([^']+)'\)/g;
  const files = {};
  while ((m = importRe.exec(text))) files[m[1]] = m[2];

  return mounts
    .filter((x) => files[x.varName])
    .map((x) => ({
      prefix: x.prefix,
      file: path.join(SRC, 'routes', files[x.varName]) + '.js',
    }));
};

/// Some modules guard EVERY route at the router level instead of per-route:
///     router.use(authenticate, requireType('ADMIN'));
/// Those routes carry no inline guard, so without this they'd be reported as
/// public — the opposite of the truth. Returns the blanket access level, if any.
const routerLevelAccess = (fileText) => {
  const m = fileText.match(/router\.use\(\s*([^)]*authenticate[^;]*?)\)\s*;/);
  if (!m) return null;
  const chain = m[1];
  if (/ADMIN/.test(chain)) return 'Admin';
  if (/PARTNER/.test(chain)) return 'Partner';
  if (/CUSTOMER/.test(chain)) return 'Customer';
  return 'Authenticated';
};

/// Human label for the guard middleware used on a route.
const accessOf = (middleware, fileText) => {
  const has = (name) => new RegExp(`\\b${name}\\b`).test(middleware);
  if (has('adminOnly') || /requireType\('ADMIN'\)/.test(middleware)) return 'Admin';
  if (has('partnerOnly') || /requireType\('PARTNER'\)/.test(middleware)) return 'Partner';
  if (has('customerOnly') || /requireType\('CUSTOMER'\)/.test(middleware)) return 'Customer';
  if (has('authenticate') || has('protect')) return 'Authenticated';
  /// Some modules alias their guards; fall back to scanning the alias def.
  const alias = middleware.match(/\b(\w*Only|\w*Guard)\b/);
  if (alias) {
    const def = fileText.match(new RegExp(`const\\s+${alias[1]}\\s*=\\s*\\[([^\\]]+)\\]`));
    if (def) {
      if (/ADMIN/.test(def[1])) return 'Admin';
      if (/PARTNER/.test(def[1])) return 'Partner';
      if (/CUSTOMER/.test(def[1])) return 'Customer';
      return 'Authenticated';
    }
  }
  return routerLevelAccess(fileText) ?? 'Public';
};

/// Permission string from requirePermission('bookings.view').
const permissionOf = (middleware) => {
  const m = middleware.match(/requirePermission\('([^']+)'\)/);
  return m ? m[1] : null;
};

/// Validator schema name, useful as a hint at the expected payload.
const schemaOf = (middleware) => {
  const m = middleware.match(/validate\((\w+)/);
  return m ? m[1] : null;
};

/// Nearest preceding comment block, used as the endpoint description.
const describe = (lines, idx) => {
  const out = [];
  for (let i = idx - 1; i >= 0; i -= 1) {
    const raw = lines[i].trim();
    if (!raw) { if (out.length) break; else continue; }
    if (raw.startsWith('//') || raw.startsWith('///') || raw.startsWith('*') || raw.startsWith('/*')) {
      out.unshift(raw.replace(/^\/+\**\s?|^\*+\/?\s?|─+/g, '').trim());
    } else break;
  }
  return out.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
};

const extract = () => {
  const groups = [];
  for (const { prefix, file } of readMounts()) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const endpoints = [];

    /// Scan the whole file, not line-by-line: several modules wrap the
    /// registration across lines (path on its own line), which a
    /// line-anchored match would miss entirely.
    const re = /router\.(get|post|put|patch|delete)\(\s*'([^']*)'/g;
    let m;
    while ((m = re.exec(text))) {
      const [, method, routePath] = m;
      /// Everything between the path and the closing `);` is the middleware
      /// chain plus the controller reference.
      const after = text.slice(m.index + m[0].length);
      const middleware = after.slice(0, after.indexOf(');'));
      /// Line number of this registration, so we can pick up the comment
      /// block immediately above it.
      const lineNo = text.slice(0, m.index).split('\n').length - 1;
      const full = (prefix + routePath).replace(/\/+$/, '') || prefix;
      endpoints.push({
        method: method.toUpperCase(),
        path: '/api/v1' + full,
        access: accessOf(middleware, text),
        permission: permissionOf(middleware),
        schema: schemaOf(middleware),
        description: describe(lines, lineNo),
      });
    }

    if (endpoints.length) {
      groups.push({
        name: prefix.replace(/^\//, ''),
        prefix: '/api/v1' + prefix,
        file: path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/'),
        endpoints,
      });
    }
  }
  return groups;
};

if (require.main === module) {
  const groups = extract();
  const total = groups.reduce((n, g) => n + g.endpoints.length, 0);
  fs.writeFileSync(
    path.join(__dirname, 'api-endpoints.json'),
    JSON.stringify({ groups, total }, null, 2),
  );
  console.log(`extracted ${total} endpoints across ${groups.length} groups`);
}

module.exports = { extract };
