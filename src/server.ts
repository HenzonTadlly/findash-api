import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { prisma } from './lib/prisma.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authMiddleware } from './middlewares/auth.js';

dotenv.config();

const app = express();

app.use(express.json());
app.use(cors());

// Rota "raiz" para verificar se a API está no ar
app.get('/', (req, res) => {
  return res.json({ message: 'FinDash API está no ar!' });
});


// --- ROTAS DE USUÁRIO E SESSÃO ---
app.post('/users', async (req, res) => {
  try {
    const { email, name, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios.' });
    }
    const userAlreadyExists = await prisma.user.findUnique({ where: { email } });
    if (userAlreadyExists) {
      return res.status(409).json({ error: 'Este email já está em uso.' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { email, name, password: hashedPassword } });
    const { password: _, ...userWithoutPassword } = user;
    return res.status(201).json(userWithoutPassword);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Ocorreu um erro no servidor.' });
  }
});

app.post('/sessions', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Email ou senha inválidos.' });
    }
    const isPasswordCorrect = await bcrypt.compare(password, user.password);
    if (!isPasswordCorrect) {
      return res.status(401).json({ error: 'Email ou senha inválidos.' });
    }
    const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET as string, { expiresIn: '1d' });
    const { password: _, ...userWithoutPassword } = user;
    return res.status(200).json({ user: userWithoutPassword, token });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Ocorreu um erro no servidor.' });
  }
});


// --- ROTAS DE TRANSAÇÕES (TODAS PROTEGIDAS) ---
// O middleware é aplicado a todas as rotas definidas neste grupo
const transactionRoutes = express.Router();
transactionRoutes.use(authMiddleware);

// ROTA PARA LISTAR AS TRANSAÇÕES (COM FILTROS)
transactionRoutes.get('/', async (req, res) => {
  try {
    // @ts-ignore
    const userId = req.userId;
    const { year, month } = req.query;

    const where: any = { userId };

    if (year && month) {
      const numericYear = parseInt(year as string);
      const numericMonth = parseInt(month as string);
      const startDate = new Date(numericYear, numericMonth - 1, 1);
      const endDate = new Date(numericYear, numericMonth, 0, 23, 59, 59);
      where.date = { gte: startDate, lte: endDate };
    }

    const transactions = await prisma.transaction.findMany({
      where,
      orderBy: { date: 'desc' },
    });
    return res.status(200).json(transactions);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Ocorreu um erro ao buscar as transações.' });
  }
});

// ROTA PARA CRIAR UMA NOVA TRANSAÇÃO
transactionRoutes.post('/', async (req, res) => {
  try {
    // @ts-ignore
    const userId = req.userId;
    const { title, amount, type, category, date } = req.body;
    if (!title || !amount || !type || !category || !date) {
      return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
    }
    const transaction = await prisma.transaction.create({
      data: { title, amount, type, category, date: new Date(date), userId },
    });
    return res.status(201).json(transaction);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Ocorreu um erro ao criar a transação.' });
  }
});

// ROTA PARA IMPORTAR E CATEGORIZAR TRANSAÇÕES
transactionRoutes.post('/import', async (req, res) => {
  try {
    // @ts-ignore
    const userId = req.userId;
    const { textContent } = req.body;
    if (!textContent) {
      return res.status(400).json({ error: 'Nenhum conteúdo de texto fornecido.' });
    }

    const lines = textContent.split('\n').filter((line: string) => line.trim() !== '');
    const transactionsToCreate = [];

    for (const line of lines) {
      const match = line.match(/^(\d{2}\/\d{2}\/\d{4})\s*-\s*(.+?)\s*-\s*R\$\s*([\d,.]+)/);
      if (match) {
        const [, dateStr, description, amountStr] = match;
        
        let category = 'Outros';
        const lowerCaseDescription = description.toLowerCase();
        if (lowerCaseDescription.includes('ifood') || lowerCaseDescription.includes('restaurante')) category = 'Alimentação';
        else if (lowerCaseDescription.includes('uber') || lowerCaseDescription.includes('99')) category = 'Transporte';
        else if (lowerCaseDescription.includes('netflix') || lowerCaseDescription.includes('spotify')) category = 'Assinaturas';
        else if (lowerCaseDescription.includes('aluguel') || lowerCaseDescription.includes('condominio')) category = 'Moradia';
        else if (lowerCaseDescription.includes('mercado') || lowerCaseDescription.includes('supermercado')) category = 'Supermercado';

        const [day, month, year] = dateStr.split('/');
        const date = new Date(`${year}-${month}-${day}`);
        const amount = parseFloat(amountStr.replace(/\./g, '').replace(',', '.'));

        transactionsToCreate.push({
          title: description, amount, type: 'EXPENSE', category, date, userId,
        });
      }
    }
    
    if (transactionsToCreate.length > 0) {
      await prisma.transaction.createMany({ data: transactionsToCreate });
    }

    return res.status(201).json({ message: `${transactionsToCreate.length} transações importadas com sucesso.` });
  } catch (error) {
    console.error("Erro na importação:", error);
    return res.status(500).json({ error: 'Ocorreu um erro ao importar as transações.' });
  }
});

// ROTA PARA ATUALIZAR UMA TRANSAÇÃO
transactionRoutes.put('/:id', async (req, res) => {
  try {
    // @ts-ignore
    const userId = req.userId;
    const { id } = req.params;
    const { title, amount, type, category, date } = req.body;
    
    const transaction = await prisma.transaction.findFirst({ where: { id, userId } });
    if (!transaction) {
      return res.status(404).json({ error: 'Transação não encontrada ou acesso negado.' });
    }

    const updatedTransaction = await prisma.transaction.update({
      where: { id },
      data: { title, amount, type, category, date: date ? new Date(date) : undefined },
    });
    return res.status(200).json(updatedTransaction);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Ocorreu um erro ao atualizar a transação.' });
  }
});

transactionRoutes.delete('/:id', async (req, res) => {
  try {
    // @ts-ignore
    const userId = req.userId;
    const { id } = req.params;

    const transaction = await prisma.transaction.findFirst({ where: { id, userId } });
    if (!transaction) {
      return res.status(404).json({ error: 'Transação não encontrada ou acesso negado.' });
    }

    await prisma.transaction.delete({ where: { id } });
    return res.status(204).send();
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Ocorreu um erro ao deletar a transação.' });
  }
});

// Usando o roteador para o prefixo '/transactions'
app.use('/transactions', transactionRoutes);


// Exportar o app para a Vercel
export default app;