import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// Definimos uma interface para adicionar a propriedade 'userId' ao Request
interface TokenPayload {
  sub: string;
  iat: number;
  exp: number;
}

export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // 1. Buscar o token do cabeçalho da requisição
  const { authorization } = req.headers;

  // 2. Verificar se o token foi enviado
  if (!authorization) {
    return res.status(401).json({ error: 'Token não fornecido.' });
  }

  // 3. Separar o "Bearer" do token
  // O formato é "Bearer TOKEN_LONGO". O split divide a string em um array: ['Bearer', 'TOKEN_LONGO']
  const [, token] = authorization.split(' ');

  // 4. Validar o token
  try {
    // jwt.verify vai checar se o token é válido usando nosso segredo.
    // Se for inválido ou expirado, ele vai disparar um erro (que será pego pelo catch).
    const payload = jwt.verify(token, process.env.JWT_SECRET as string);

    // O payload decodificado contém nosso `sub` (que é o ID do usuário).
    const { sub } = payload as TokenPayload;

    // Adicionamos o ID do usuário ao objeto `req` para que as rotas
    // futuras possam saber quem está fazendo a requisição.
    // @ts-ignore
    req.userId = sub;

    // 5. Chamar o next() para continuar para a rota principal
    return next();
  } catch (error) {
    // Se jwt.verify falhar, o token é inválido.
    return res.status(401).json({ error: 'Token inválido.' });
  }
}