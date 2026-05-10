const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const email = process.argv[2];

if (!email) {
  console.error('Please provide an email address');
  process.exit(1);
}

async function main() {
  const user = await prisma.user.update({
    where: { email },
    data: { internalRole: 'SUPER_ADMIN' },
  });
  console.log(`Successfully promoted ${user.email} to SUPER_ADMIN`);
}

main()
  .catch((e) => {
    console.error('Error:', e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
