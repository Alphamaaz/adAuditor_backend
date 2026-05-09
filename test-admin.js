import { listUsers } from './src/modules/admin/admin.controller.js';
import { prisma } from './src/lib/prisma.js';

const mockRes = {
  json: (data) => {
    console.log('API RESPONSE:', JSON.stringify(data, null, 2));
  }
};

const mockReq = {
  query: { page: 1, limit: 10, search: '' }
};

console.log('Running direct listUsers check...');
listUsers(mockReq, mockRes).catch(err => console.error(err));
