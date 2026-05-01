// scripts/check.js — Diagnostique la connexion et les données
import 'dotenv/config';
import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/ima_awards';

console.log('🔍 IMA Awards — Diagnostic\n');
console.log(`📡 Tentative de connexion à: ${MONGODB_URI}`);

try {
  await mongoose.connect(MONGODB_URI);
  console.log('✅ MongoDB connecté\n');

  const Artist   = (await import('../models/Artist.js')).default;
  const Category = (await import('../models/Category.js')).default;
  const User     = (await import('../models/User.js')).default;

  const [artists, categories, users] = await Promise.all([
    Artist.countDocuments(),
    Category.countDocuments(),
    User.countDocuments(),
  ]);

  console.log('📊 Données en base :');
  console.log(`   Artistes    : ${artists}`);
  console.log(`   Catégories  : ${categories}`);
  console.log(`   Utilisateurs: ${users}`);

  if (artists === 0 || categories === 0) {
    console.log('\n⚠️  Base de données VIDE — Exécutez : npm run seed');
  } else {
    console.log('\n✅ Données présentes — le frontend devrait afficher les données');
    console.log('\n   Si le frontend affiche toujours rien, vérifiez que :');
    console.log('   1. npm run dev (backend) tourne sur le port 5000');
    console.log('   2. npm run dev (frontend) tourne sur le port 5173');
  }

  await mongoose.disconnect();
  process.exit(0);
} catch (err) {
  console.error(`\n❌ Erreur : ${err.message}`);
  if (err.message.includes('ECONNREFUSED')) {
    console.log('\n💡 MongoDB n\'est pas démarré.');
    console.log('   Lancez MongoDB puis relancez ce script.');
  }
  process.exit(1);
}
