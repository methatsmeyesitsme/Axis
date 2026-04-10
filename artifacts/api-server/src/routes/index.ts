import { Router, type IRouter } from "express";
import healthRouter from "./health";
import openaiRouter from "./openai";
import authRouter from "./auth";
import cortexRouter from "./cortex";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/openai", openaiRouter);
router.use("/cortex", cortexRouter);

export default router;
