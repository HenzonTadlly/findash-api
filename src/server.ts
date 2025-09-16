import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { prisma } from './lib/prisma';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authMiddleware } from './middlewares/auth';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3333;

app.use(express.json());
app.use(cors());

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


// --- ROTAS DE TRANSAÇÕES ---
app.use('/transactions', authMiddleware);

// ... (O resto do seu código server.ts permanece o mesmo) ...

// --- ROTA PARA LISTAR AS TRANSAÇÕES (AGORA COM FILTROS) ---
app.get('/transactions', authMiddleware, async (req, res) => {
  try {
    // @ts-ignore
    const userId = req.userId;
    const { year, month } = req.query; // Pegamos os filtros da URL

    // Construção da query do Prisma de forma dinâmica
    const where: any = {
      userId: userId,
    };

    // Se 'year' e 'month' forem fornecidos, adicionamos o filtro de data
    if (year && month) {
      const numericYear = parseInt(year as string);
      const numericMonth = parseInt(month as string);

      // Criamos a data de início do mês (ex: 01/09/2025 00:00:00)
      const startDate = new Date(numericYear, numericMonth - 1, 1);
      // Criamos a data de fim do mês (ex: 30/09/2025 23:59:59)
      const endDate = new Date(numericYear, numericMonth, 0, 23, 59, 59);

      where.date = {
        gte: startDate, // gte = Greater Than or Equal (Maior ou igual a)
        lte: endDate,   // lte = Less Than or Equal (Menor ou igual a)
      };
    }

    const transactions = await prisma.transaction.findMany({
      where: where, // Usamos nosso objeto 'where' dinâmico
      orderBy: {
        date: 'desc',
      },
    });

    return res.status(200).json(transactions);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Ocorreu um erro ao buscar as transações.' });
  }
});


app.post('/transactions', async (req, res) => {
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

app.post('/transactions', authMiddleware, async (req, res) => { /* ...código existente... */ });


// --- NOVA ROTA PARA IMPORTAR E CATEGORIZAR TRANSAÇÕES ---
app.post('/transactions/import', authMiddleware, async (req, res) => {
  try {
    // @ts-ignore
    const userId = req.userId;
    const { textContent } = req.body;

    if (!textContent) {
      return res.status(400).json({ error: 'Nenhum conteúdo de texto fornecido.' });
    }

    // Dividir o texto em linhas
    const lines = textContent.split('\n').filter((line: string) => line.trim() !== '');

    const transactionsToCreate = [];

    for (const line of lines) {
      // Usamos uma expressão regular para extrair os dados de cada linha
      // Formato esperado: DD/MM/AAAA - NOME DO LUGAR - R$ VALOR
      const match = line.match(/^(\d{2}\/\d{2}\/\d{4})\s*-\s*(.+?)\s*-\s*R\$\s*([\d,.]+)/);

      if (match) {
        const [, dateStr, description, amountStr] = match;
        
        // --- LÓGICA DE CATEGORIZAÇÃO AUTOMÁTICA ---
        let category = 'Outros'; // Categoria padrão
        const lowerCaseDescription = description.toLowerCase();

        if (lowerCaseDescription.includes('ifood') || lowerCaseDescription.includes('restaurante')) {
          category = 'Alimentação';
        } else if (lowerCaseDescription.includes('uber') || lowerCaseDescription.includes('99')) {
          category = 'Transporte';
        } else if (lowerCaseDescription.includes('netflix') || lowerCaseDescription.includes('spotify') || lowerCaseDescription.includes('disney+')) {
          category = 'Assinaturas';
        } else if (lowerCaseDescription.includes('aluguel') || lowerCaseDescription.includes('condominio')) {
          category = 'Moradia';
        } else if (lowerCaseDescription.includes('mercado') || lowerCaseDescription.includes('supermercado')) {
          category = 'Supermercado';
        }

        // Limpeza e conversão dos dados
        const [day, month, year] = dateStr.split('/');
        const date = new Date(`${year}-${month}-${day}`);
        const amount = parseFloat(amountStr.replace('.', '').replace(',', '.'));

        transactionsToCreate.push({
          title: description,
          amount: amount,
          type: 'EXPENSE', // Assumimos que todas as importações são despesas por enquanto
          category: category,
          date: date,
          userId: userId,
        });
      }
    }
    
    // Usar 'createMany' do Prisma para inserir todas as transações de uma vez (muito eficiente)
    if (transactionsToCreate.length > 0) {
      await prisma.transaction.createMany({
        data: transactionsToCreate,
      });
    }

    return res.status(201).json({ message: `${transactionsToCreate.length} transações importadas com sucesso.` });

  } catch (error) {
    console.error("Erro na importação:", error);
    return res.status(500).json({ error: 'Ocorreu um erro ao importar as transações.' });
  }
});


app.put('/transactions/:id', async (req, res) => {
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

app.delete('/transactions/:id', async (req, res) => {
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

app.listen(3333, () => {
  console.log('🚀 Servidor rodando na porta 3333');
});

export default app;