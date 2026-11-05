export type Role = "admin" | "viewer";

const tokenRoles = new Map<string, string>([
  ["admin-secret", "admin"],
  ["viewer-secret", "viewer"],
]);

const bearerPattern = /^Bearer (\S+)$/;

export function normalizeRole(role: string | undefined): Role | null {
  if (role === undefined) {
    return null;
  }

  return role === "admin" ? "admin" : "viewer";
}

export function authenticate(
  authorizationHeader: string | undefined
): Role | null {
  if (authorizationHeader === undefined) {
    return null;
  }

  const match = bearerPattern.exec(authorizationHeader);

  if (match === null) {
    return null;
  }

  const token = match[1];

  if (token === undefined) {
    return null;
  }

  return normalizeRole(tokenRoles.get(token));
}