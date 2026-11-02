import { Schema, model } from 'mongoose';

const counterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false });

const Counter = model('Counter', counterSchema);

// Atomic sequence for human-readable invoice numbers
export async function nextSequence(name) {
  const counter = await Counter.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return counter.seq;
}

export default Counter;
