export const cookieParser = (req, res, next) => {
  const cookieHeader = req.headers.cookie;
  req.cookies = {};

  if (!cookieHeader) {
    next();
    return;
  }

  for (const pair of cookieHeader.split(";")) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();

    if (!key) continue;

    try {
      req.cookies[key] = decodeURIComponent(value);
    } catch {
      req.cookies[key] = value;
    }
  }

  next();
};
