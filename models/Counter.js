import { Schema } from 'mongoose';

const counterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false });

// Atomic sequence for human-readable invoice numbers: Counter.next('sale')
counterSchema.statics.next = async function next(name) {
  const counter = await this.findByIdAndUpdate(name, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return counter.seq;
};

export default counterSchema;
