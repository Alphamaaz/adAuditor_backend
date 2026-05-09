import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasourceUrl: "postgresql://ad_auditor:ad_auditor_password@localhost:5432/ad_auditor_dev?schema=public"
});

async function main() {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, internalRole: true }
  });
  
  if (users.length === 0) {
    console.log('No users found in database. Please sign up on the website first!');
    return;
  }

  console.log('Current Users:');
  console.table(users);

  const hasAdmin = users.some(u => u.internalRole === 'SUPER_ADMIN');
  if (!hasAdmin) {
    const userToPromote = users[0];
    await prisma.user.update({
      where: { id: userToPromote.id },
      data: { internalRole: 'SUPER_ADMIN' }
    });
    console.log(`Promoted ${userToPromote.email} to SUPER_ADMIN`);
  } else {
    console.log('At least one SUPER_ADMIN already exists.');
  }
}

main()
  .catch((e) => console.error(e))
  .finally(async () => await prisma.$disconnect());
