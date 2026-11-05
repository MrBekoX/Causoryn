/**
 * fixture-ts-nextjs — servis katmanı.
 *
 * Route handler'ların çağırdığı servis fonksiyonları; adapter'ın CALLS
 * çıkarsımı route → servis zincirini gerçek projeye benzer biçimde kurar.
 */

export interface User {
  readonly id: string;
  readonly name: string;
}

const users: User[] = [];

export function listUsers(): readonly User[] {
  return users;
}

export function createUser(name: string): User {
  const user: User = { id: `u-${users.length + 1}`, name };
  users.push(user);
  return user;
}
