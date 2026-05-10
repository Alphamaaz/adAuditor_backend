import { prisma } from '../lib/prisma.js';

const email = process.argv[2];

if (!email) {
  console.error('Please provide an email address');
  process.exit(1);
}

async function main() {
  console.log(`Searching for user: ${email}...`);
  
  const user = await prisma.user.update({
    where: { email: email },
    data: { internalRole: 'SUPER_ADMIN' },
  });
  
  console.log(`Success! ${user.email} is now a SUPER_ADMIN.`);
}

main()
  .catch((e) => {
    console.error('Error:', e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
