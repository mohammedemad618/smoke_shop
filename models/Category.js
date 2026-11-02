import { Schema, model } from 'mongoose';

const categorySchema = new Schema(
  {
    name: {
      type: String,
      required: [true, 'اسم القسم مطلوب'],
      trim: true,
      maxlength: [60, 'اسم القسم طويل جدًا'],
      unique: true,
    },
  },
  { timestamps: true },
);

export default model('Category', categorySchema);
